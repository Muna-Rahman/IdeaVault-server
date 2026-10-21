const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const { requireAuth, sameEmail } = require("./auth");

const app = express();
const port = process.env.PORT || 5000;

/* ---------------------------------- CORS --------------------------------- */
const allowedOrigins = [
  "http://localhost:3000",
  "https://ideavaultclient-beta.vercel.app",
  process.env.CLIENT_URL && process.env.CLIENT_URL.replace(/\/+$/, ""),
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || /\.vercel\.app$/.test(new URL(origin).hostname)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "100kb" }));

/* -------------------------------- Database ------------------------------- */
const uri = process.env.MONGODB_URI;
let clientPromise = null;
let indexesEnsured = false;

function getClientPromise() {
  if (!uri) throw new Error("MONGODB_URI environment variable is not set.");
  if (!clientPromise) {
    const client = new MongoClient(uri, {
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      maxPoolSize: 5,
    });
    clientPromise = client.connect().catch((err) => {
      clientPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return clientPromise;
}

async function connectToDatabase() {
  const client = await getClientPromise();
  const database = client.db(process.env.MONGODB_DB || "ideavault");
  const ideacollection = database.collection("ideas");
  const commentcollection = database.collection("comments");

  if (!indexesEnsured) {
    indexesEnsured = true;
    Promise.all([
      ideacollection.createIndex({ createdAt: -1 }),
      ideacollection.createIndex({ userEmail: 1, createdAt: -1 }),
      ideacollection.createIndex({ commentCount: -1, createdAt: -1 }),
      commentcollection.createIndex({ ideaId: 1, createdAt: -1 }),
      commentcollection.createIndex({ userEmail: 1, createdAt: -1 }),
    ]).catch((e) => console.error("Index creation skipped:", e.message));
  }
  return { ideacollection, commentcollection };
}

/* -------------------------------- Helpers -------------------------------- */
const CATEGORIES = ["Tech", "Health", "AI", "Education", "Agriculture", "Fintech"];

const errMsg = (error) => (error && error.message ? error.message : String(error));
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const str = (v) => (typeof v === "string" ? v.trim() : "");

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function serverError(res, label, error, publicMessage) {
  console.error(label, error);
  return res.status(500).json({ success: false, message: publicMessage, error: errMsg(error) });
}

// Validates + normalises idea fields. Returns { value } or { error }.
// With `partial` true only fields that were sent are checked/returned.
function validateIdea(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;

  const title = body.ideaTitle ?? body.title;
  if (!partial || title !== undefined) {
    const t = str(title);
    if (t.length < 3 || t.length > 120) return { error: "Title must be 3-120 characters." };
    out.ideaTitle = t;
  }

  if (!partial || has("category")) {
    const match = CATEGORIES.find((c) => c.toLowerCase() === str(body.category).toLowerCase());
    if (!match) return { error: `Category must be one of: ${CATEGORIES.join(", ")}.` };
    out.category = match;
  }

  const limits = {
    shortDescription: [10, 300, true],
    detailedDescription: [0, 5000, false],
    targetAudience: [0, 200, false],
    problemStatement: [0, 2000, false],
    proposedSolution: [0, 2000, false],
  };
  for (const [key, [min, max, required]] of Object.entries(limits)) {
    if (!partial && !has(key) && !required) continue;
    if (partial && !has(key)) continue;
    const v = str(body[key]);
    if (v.length < min || v.length > max) {
      return { error: `${key} must be ${min ? `${min}-` : "up to "}${max} characters.` };
    }
    out[key] = v;
  }

  if (has("imageUrl")) {
    const url = str(body.imageUrl);
    if (url && !/^https?:\/\/\S+$/i.test(url)) return { error: "Image URL must start with http:// or https://." };
    out.imageUrl = url;
  }

  if (has("estimatedBudget")) {
    if (body.estimatedBudget === null || body.estimatedBudget === "") {
      out.estimatedBudget = null;
    } else {
      const n = Number(body.estimatedBudget);
      if (!Number.isFinite(n) || n < 0) return { error: "Budget must be a positive number." };
      out.estimatedBudget = n;
    }
  }

  if (has("tags")) {
    if (!Array.isArray(body.tags)) return { error: "Tags must be a list." };
    out.tags = [...new Set(body.tags.map(str).filter(Boolean))].slice(0, 10).map((t) => t.slice(0, 30));
  }

  return { value: out };
}

/* --------------------------------- Routes -------------------------------- */
app.get("/", (req, res) => res.send("IdeaVault Node API is running smoothly..."));

app.get("/health", async (req, res) => {
  try {
    const { ideacollection } = await connectToDatabase();
    const count = await ideacollection.estimatedDocumentCount();
    res.json({ ok: true, db: "connected", ideas: count });
  } catch (error) {
    res.status(500).json({ ok: false, db: "failed", message: errMsg(error) });
  }
});

// ---- Ideas (public reads) ----
app.get("/ideas/trending", async (req, res) => {
  try {
    const { ideacollection } = await connectToDatabase();
    const ideas = await ideacollection.find().sort({ commentCount: -1, createdAt: -1 }).limit(6).toArray();
    res.json(ideas);
  } catch (error) {
    serverError(res, "Trending failed:", error, "Failed to load trending items.");
  }
});

// Only the owner can list their own ideas.
app.get("/ideas/user/:email", requireAuth, async (req, res) => {
  if (!sameEmail(req.user.email, req.params.email)) return fail(res, 403, "You can only view your own ideas.");
  try {
    const { ideacollection } = await connectToDatabase();
    const ideas = await ideacollection.find({ userEmail: req.user.email }).sort({ createdAt: -1 }).toArray();
    res.json(ideas);
  } catch (error) {
    serverError(res, "User ideas failed:", error, "Failed to fetch your ideas.");
  }
});

app.get("/ideas/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return fail(res, 400, "Invalid idea id.");
  try {
    const { ideacollection } = await connectToDatabase();
    const idea = await ideacollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!idea) return fail(res, 404, "Idea not found.");
    res.json(idea);
  } catch (error) {
    serverError(res, "Idea fetch failed:", error, "Failed to load this idea.");
  }
});

app.get("/ideas", async (req, res) => {
  try {
    const { ideacollection } = await connectToDatabase();
    const { search, category, startDate, endDate } = req.query;
    const filter = {};

    if (search) filter.ideaTitle = { $regex: escapeRegex(search), $options: "i" };
    if (category && category !== "All") {
      filter.category = { $regex: `^${escapeRegex(category)}$`, $options: "i" };
    }
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate && !isNaN(new Date(startDate))) filter.createdAt.$gte = new Date(startDate);
      if (endDate && !isNaN(new Date(endDate))) filter.createdAt.$lte = new Date(endDate);
      if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const ideas = await ideacollection.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
    res.json(ideas);
  } catch (error) {
    serverError(res, "Ideas query failed:", error, "Internal server read failure.");
  }
});

// ---- Ideas (protected writes) ----
app.post("/ideas", requireAuth, async (req, res) => {
  const { value, error } = validateIdea(req.body || {});
  if (error) return fail(res, 400, error);
  try {
    const { ideacollection } = await connectToDatabase();
    const doc = {
      tags: [],
      imageUrl: "",
      estimatedBudget: null,
      detailedDescription: "",
      targetAudience: "",
      problemStatement: "",
      proposedSolution: "",
      ...value,
      userEmail: req.user.email, // always taken from the verified token
      userName: req.user.name,
      commentCount: 0,
      createdAt: new Date(),
    };
    const result = await ideacollection.insertOne(doc);
    res.status(201).json({ success: true, message: "Idea saved.", insertedId: result.insertedId });
  } catch (err) {
    serverError(res, "Idea insert failed:", err, "Could not save your idea.");
  }
});

app.put("/ideas/:id", requireAuth, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return fail(res, 400, "Invalid idea id.");
  const { value, error } = validateIdea(req.body || {}, { partial: true });
  if (error) return fail(res, 400, error);
  try {
    const { ideacollection } = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const existing = await ideacollection.findOne({ _id }, { projection: { userEmail: 1 } });
    if (!existing) return fail(res, 404, "Idea not found.");
    if (!sameEmail(existing.userEmail, req.user.email)) return fail(res, 403, "You can only edit your own ideas.");

    await ideacollection.updateOne({ _id }, { $set: { ...value, updatedAt: new Date() } });
    res.json({ success: true, message: "Idea updated." });
  } catch (err) {
    serverError(res, "Idea update failed:", err, "Could not update this idea.");
  }
});

app.delete("/ideas/:id", requireAuth, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return fail(res, 400, "Invalid idea id.");
  try {
    const { ideacollection, commentcollection } = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const existing = await ideacollection.findOne({ _id }, { projection: { userEmail: 1 } });
    if (!existing) return fail(res, 404, "Idea not found.");
    if (!sameEmail(existing.userEmail, req.user.email)) return fail(res, 403, "You can only delete your own ideas.");

    await ideacollection.deleteOne({ _id });
    await commentcollection.deleteMany({ ideaId: req.params.id });
    res.json({ success: true, message: "Idea and its comments deleted." });
  } catch (err) {
    serverError(res, "Idea delete failed:", err, "Could not delete this idea.");
  }
});

// ---- Comments ----
app.get("/comments/:ideaId", async (req, res) => {
  try {
    const { commentcollection } = await connectToDatabase();
    const comments = await commentcollection.find({ ideaId: req.params.ideaId }).sort({ createdAt: -1 }).toArray();
    res.json(comments);
  } catch (error) {
    serverError(res, "Comments fetch failed:", error, "Failed to load comments.");
  }
});

app.post("/comments", requireAuth, async (req, res) => {
  const { ideaId } = req.body || {};
  const commentText = str(req.body && req.body.commentText);
  if (!ideaId || !ObjectId.isValid(ideaId)) return fail(res, 400, "Invalid idea id.");
  if (commentText.length < 1 || commentText.length > 1000) return fail(res, 400, "Comment must be 1-1000 characters.");

  try {
    const { ideacollection, commentcollection } = await connectToDatabase();
    const ideaExists = await ideacollection.countDocuments({ _id: new ObjectId(ideaId) }, { limit: 1 });
    if (!ideaExists) return fail(res, 404, "Idea not found.");

    const doc = {
      ideaId: String(ideaId),
      userName: req.user.name,
      userEmail: req.user.email, // from the verified token, not the request body
      commentText,
      createdAt: new Date(),
    };
    const result = await commentcollection.insertOne(doc);
    await ideacollection.updateOne({ _id: new ObjectId(ideaId) }, { $inc: { commentCount: 1 } });
    res.status(201).json({ success: true, comment: { ...doc, _id: result.insertedId } });
  } catch (error) {
    serverError(res, "Comment insert failed:", error, "Could not post your comment.");
  }
});

app.patch("/comments/:commentId", requireAuth, async (req, res) => {
  if (!ObjectId.isValid(req.params.commentId)) return fail(res, 400, "Invalid comment id.");
  const commentText = str(req.body && req.body.commentText);
  if (commentText.length < 1 || commentText.length > 1000) return fail(res, 400, "Comment must be 1-1000 characters.");

  try {
    const { commentcollection } = await connectToDatabase();
    const _id = new ObjectId(req.params.commentId);
    const existing = await commentcollection.findOne({ _id }, { projection: { userEmail: 1 } });
    if (!existing) return fail(res, 404, "Comment not found.");
    if (!sameEmail(existing.userEmail, req.user.email)) return fail(res, 403, "You can only edit your own comments.");

    await commentcollection.updateOne({ _id }, { $set: { commentText, updatedAt: new Date() } });
    res.json({ success: true, message: "Comment updated." });
  } catch (error) {
    serverError(res, "Comment update failed:", error, "Could not update your comment.");
  }
});

app.delete("/comments/:commentId", requireAuth, async (req, res) => {
  if (!ObjectId.isValid(req.params.commentId)) return fail(res, 400, "Invalid comment id.");
  try {
    const { ideacollection, commentcollection } = await connectToDatabase();
    const _id = new ObjectId(req.params.commentId);
    const existing = await commentcollection.findOne({ _id });
    if (!existing) return fail(res, 404, "Comment not found.");
    if (!sameEmail(existing.userEmail, req.user.email)) return fail(res, 403, "You can only delete your own comments.");

    await commentcollection.deleteOne({ _id });
    if (existing.ideaId && ObjectId.isValid(existing.ideaId)) {
      await ideacollection.updateOne(
        { _id: new ObjectId(existing.ideaId), commentCount: { $gt: 0 } },
        { $inc: { commentCount: -1 } }
      );
    }
    res.json({ success: true, message: "Comment deleted." });
  } catch (error) {
    serverError(res, "Comment delete failed:", error, "Could not delete your comment.");
  }
});

// ---- Personal activity (owner only) ----
app.get("/user-interactions/:email", requireAuth, async (req, res) => {
  if (!sameEmail(req.user.email, req.params.email)) return fail(res, 403, "You can only view your own activity.");
  try {
    const { ideacollection, commentcollection } = await connectToDatabase();
    const comments = await commentcollection.find({ userEmail: req.user.email }).sort({ createdAt: -1 }).toArray();

    const objectIds = [...new Set(comments.map((c) => c.ideaId))]
      .filter((id) => id && ObjectId.isValid(id))
      .map((id) => new ObjectId(id));

    const ideas = objectIds.length ? await ideacollection.find({ _id: { $in: objectIds } }).toArray() : [];

    res.json(
      ideas.map((idea) => ({
        _id: idea._id,
        ideaTitle: idea.ideaTitle,
        category: idea.category,
        shortDescription: idea.shortDescription,
        userComments: comments
          .filter((c) => String(c.ideaId) === String(idea._id))
          .map((c) => ({ commentId: c._id, commentText: c.commentText, createdAt: c.createdAt })),
      }))
    );
  } catch (error) {
    serverError(res, "Interactions failed:", error, "Could not load your activity.");
  }
});

/* ------------------------------ Fallbacks -------------------------------- */
app.use((req, res) => fail(res, 404, "Route not found."));
app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") return fail(res, 403, "Origin not allowed.");
  if (err && err.type === "entity.parse.failed") return fail(res, 400, "Malformed JSON body.");
  console.error("Unhandled error:", err);
  fail(res, 500, "Unexpected server error.");
});

if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => console.log(`IdeaVault Express server active on local port: ${port}`));
}

module.exports = app;