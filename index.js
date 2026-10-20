const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

// Dynamic configuration for local and production deployment
const allowedOrigins = [
  'http://localhost:3000',
  'https://ideavaultclient-beta.vercel.app'
];

app.use(
  cors({
    origin: (origin, callback) => {
      
      if (!origin || allowedOrigins.includes(origin) || origin.includes("vercel.app")) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);
app.use(express.json());

const { ObjectId } = require("mongodb");

const uri = process.env.MONGODB_URI;

// Cache the connection *promise* globally so concurrent serverless requests
// share one connection attempt, and a failed attempt can be retried.
let clientPromise = null;

function getClientPromise() {
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not set.");
  }
  if (!clientPromise) {
    const client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      maxPoolSize: 5,
    });
    clientPromise = client.connect().catch((err) => {
      clientPromise = null; // allow retry on next request
      throw err;
    });
  }
  return clientPromise;
}

async function connectToDatabase() {
  const client = await getClientPromise();
  const database = client.db(process.env.MONGODB_DB || "ideavault");
  console.log("MongoDB connection ready.");
  return {
    ideacollection: database.collection("ideas"),
    commentcollection: database.collection("comments"),
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Never leak raw Error objects (they serialize to {}) - send a readable message.
function errMsg(error) {
  return error && error.message ? error.message : String(error);
}

app.get("/", (req, res) => {
  res.send("IdeaVault Node API is running smoothly...");
});

// Quick DB connectivity check: GET /health
app.get("/health", async (req, res) => {
  try {
    const { ideacollection } = await connectToDatabase();
    const count = await ideacollection.estimatedDocumentCount();
    res.json({ ok: true, db: "connected", ideas: count });
  } catch (error) {
    res.status(500).json({ ok: false, db: "failed", message: errMsg(error) });
  }
});

// Trending Ideas Route
app.get("/ideas/trending", async (req, res) => {
  try {
    const { ideacollection } = await connectToDatabase();
    const trendingideas = await ideacollection
      .find()
      .sort({ commentCount: -1, createdAt: -1 })
      .limit(6)                  
      .toArray();                
    res.send(trendingideas);
  } catch (error) {
    console.error("Trending analytics extraction drop:", error);
    res.status(500).send({ message: "Failed to load trending items", error: errMsg(error) });
  }
});

// Single Idea Route
app.get("/ideas/:id", async (req, res) => {
  try {
    const { ideacollection } = await connectToDatabase();
    const singleId = req.params.id;
    if (!ObjectId.isValid(singleId)) {
      return res.status(400).json({ success: false, message: "Invalid idea id." });
    }

    const targetedIdea = await ideacollection.findOne({ _id: new ObjectId(singleId) });
    if (!targetedIdea) {
      return res.status(404).json({ success: false, message: "Concept document missing." });
    }
    res.json(targetedIdea);
  } catch (error) {
    res.status(500).json({ success: false, message: "Malformed identifier token parameter handling crash." });
  }
});

// User Ideas Route
app.get("/ideas/user/:email", async (req, res) => {
  try {
    const { ideacollection } = await connectToDatabase();
    const userEmail = req.params.email;
    const userIdeas = await ideacollection
      .find({ userEmail: userEmail })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(userIdeas);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch profile items." });
  }
});

// User Interactions Route
app.get("/user-interactions/:email", async (req, res) => {
  try {
    const { ideacollection, commentcollection } = await connectToDatabase();
    const userEmail = req.params.email;
    
    const interactionComments = await commentcollection
      .find({ userEmail: userEmail })
      .sort({ createdAt: -1 })
      .toArray();

    const uniqueIdeaIds = [...new Set(interactionComments.map(c => c.ideaId))];

    const objectIds = uniqueIdeaIds
      .filter(id => {
        try {
          return id && ObjectId.isValid(id);
        } catch (e) {
          return false;
        }
      })
      .map(id => new ObjectId(id));

    let associatedIdeas = [];
    if (objectIds.length > 0) {
      associatedIdeas = await ideacollection
        .find({ _id: { $in: objectIds } })
        .toArray();
    }

    const compiledInteractions = associatedIdeas.map(idea => {
      const matchingComments = interactionComments
        .filter(c => String(c.ideaId) === String(idea._id))
        .map(c => ({
          commentId: c._id,
          commentText: c.commentText,
          createdAt: c.createdAt
        }));

      return {
        _id: idea._id,
        ideaTitle: idea.ideaTitle,
        category: idea.category,
        shortDescription: idea.shortDescription,
        userComments: matchingComments
      };
    });

    res.json(compiledInteractions);
  } catch (error) {
    console.error("Interaction aggregation crash:", error);
    res.status(500).json({ success: false, message: "Internal tracker compilation breakdown." });
  }
});

// General Ideas Query Route (with Filtering)
app.get("/ideas", async (req, res) => {
  try {
    const { ideacollection } = await connectToDatabase();
    const { search, category, startDate, endDate } = req.query;
    let databaseQueryFilter = {};

    if (search) {
      const escaped = escapeRegex(search);
      databaseQueryFilter.ideaTitle = { $regex: escaped, $options: "i" };
    }

    if (category && category !== "All") {
      const escapedCat = escapeRegex(category);
      databaseQueryFilter.category = { $regex: `^${escapedCat}$`, $options: "i" };
    }

    if (startDate || endDate) {
      databaseQueryFilter.createdAt = {};
      if (startDate) {
        databaseQueryFilter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        databaseQueryFilter.createdAt.$lte = new Date(endDate);
      }
    }

    const matchedIdeas = await ideacollection
      .find(databaseQueryFilter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(matchedIdeas); 
    
  } catch (error) {
    console.error("Failed to query records from storage core:", error);
    res.status(500).json({ success: false, message: "Internal server read failure.", error: errMsg(error) });
  }
});

// Post Idea Route
app.post("/ideas", async (req, res) => {
  try {
    const { ideacollection } = await connectToDatabase();
    const payloadData = req.body;

    const customIdeaDocument = {
      ideaTitle: payloadData.title || payloadData.ideaTitle, 
      userEmail: payloadData.userEmail,
      category: payloadData.category || "Tech",
      shortDescription: payloadData.shortDescription,
      detailedDescription: payloadData.detailedDescription,
      tags: Array.isArray(payloadData.tags) ? payloadData.tags : [],
      imageUrl: payloadData.imageUrl,
      estimatedBudget: payloadData.estimatedBudget ? Number(payloadData.estimatedBudget) : null,
      targetAudience: payloadData.targetAudience,
      problemStatement: payloadData.problemStatement,
      proposedSolution: payloadData.proposedSolution,
      commentCount: 0, 
      createdAt: payloadData.createdAt ? new Date(payloadData.createdAt) : new Date()
    };

    const executionTransaction = await ideacollection.insertOne(customIdeaDocument);
    
    res.status(201).send({
      success: true,
      message: "Idea blueprint successfully stamped inside the database cluster context.",
      insertedId: executionTransaction.insertedId
    });
  } catch (error) {
    console.error("Critical block failure writing concept record:", error);
    res.status(500).send({ 
      success: false, 
      message: "Internal framework failed to write document context record safely.", 
      error: errMsg(error)
    });
  }
});

// Update Idea Route
app.put("/ideas/:id", async (req, res) => {
  try {
    const { ideacollection } = await connectToDatabase();
    const ideaId = req.params.id;
    const updatedFields = req.body;

    const modificationPayload = {
      ideaTitle: updatedFields.ideaTitle,
      category: updatedFields.category,
      shortDescription: updatedFields.shortDescription,
      detailedDescription: updatedFields.detailedDescription,
      imageUrl: updatedFields.imageUrl,
      estimatedBudget: updatedFields.estimatedBudget ? Number(updatedFields.estimatedBudget) : null,
      targetAudience: updatedFields.targetAudience,
      problemStatement: updatedFields.problemStatement,
      proposedSolution: updatedFields.proposedSolution,
      updatedAt: new Date()
    };

    const updateResult = await ideacollection.updateOne(
      { _id: new ObjectId(ideaId) },
      { $set: modificationPayload }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Document missing from database." });
    }
    res.json({ success: true, message: "Concept blueprint record rewritten cleanly." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Operational transaction crash on PUT update query hook." });
  }
});

// Delete Idea Route
app.delete("/ideas/:id", async (req, res) => {
  try {
    const { ideacollection, commentcollection } = await connectToDatabase();
    const ideaId = req.params.id;

    const deleteResult = await ideacollection.deleteOne({ _id: new ObjectId(ideaId) });
    
    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Target document not found." });
    }

    await commentcollection.deleteMany({ ideaId: ideaId });

    res.json({ success: true, message: "Concept and related conversation tracks purged successfully from disk." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Purge transaction dropped internally." });
  }
});

// Get Comments Route
app.get("/comments/:ideaId", async (req, res) => {
  try {
    const { commentcollection } = await connectToDatabase();
    const targetFeedback = await commentcollection
      .find({ ideaId: req.params.ideaId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(targetFeedback);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to read feedback tracks." });
  }
});

// Post Comment Route
app.post("/comments", async (req, res) => {
  try {
    const { ideacollection, commentcollection } = await connectToDatabase();
    const { ideaId, userName, userEmail, commentText } = req.body;

    if (!ideaId || !ObjectId.isValid(ideaId)) {
      return res.status(400).json({ success: false, message: "Invalid idea id." });
    }

    const newCommentDoc = {
      ideaId: String(ideaId),
      userName,
      userEmail,
      commentText,
      createdAt: new Date()
    };

    const writeOutcome = await commentcollection.insertOne(newCommentDoc);
    
    await ideacollection.updateOne(
      { _id: new ObjectId(ideaId) },
      { $inc: { commentCount: 1 } }
    );

    res.status(201).json({ success: true, comment: { ...newCommentDoc, _id: writeOutcome.insertedId } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Storage transaction dropped on comment write hook." });
  }
});

// Patch Comment Route
app.patch("/comments/:commentId", async (req, res) => {
  try {
    const { commentcollection } = await connectToDatabase();
    const { commentText } = req.body;

    await commentcollection.updateOne(
      { _id: new ObjectId(req.params.commentId) },
      { $set: { commentText, updatedAt: new Date() } }
    );

    res.json({ success: true, message: "Text field committed cleanly." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Operational drop processing text update step." });
  }
});

// Delete Comment Route
app.delete("/comments/:commentId", async (req, res) => {
  try {
    const { ideacollection, commentcollection } = await connectToDatabase();
    const commentId = req.params.commentId;
    const { ideaId } = req.query;

    await commentcollection.deleteOne({ _id: new ObjectId(commentId) });

    if (ideaId) {
      await ideacollection.updateOne(
        { _id: new ObjectId(ideaId) },
        { $inc: { commentCount: -1 } }
      );
    }

    res.json({ success: true, message: "Document record purged successfully from cluster stack." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Purge process crashed internally." });
  }
});


if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`IdeaVault Express server active on local port: ${port}`);
  });
}


module.exports = app;