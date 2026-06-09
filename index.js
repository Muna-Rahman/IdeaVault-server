const dns = require("dns");
// Explicit DNS resolution targeting to sweep past persistent local Windows ISP lookup blocks
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

// Rigidly bound Cross-Origin access points to allow secure front-to-back network token transfers
app.use(cors({
  origin: process.env.CLIENT_URL,
  credentials: true
}));
app.use(express.json());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function runServer() {
  try {
    
    await client.connect();
    console.log(" Successfully linked local server to MongoDB Cluster!");

    const database = client.db("ideavault");
    const ideacollection = database.collection("ideas");
    const commentcollection = database.collection("comments");

    
    app.get("/", (req, res) => {
      res.send("IdeaVault Node API is running smoothly...");
    });

    
    app.get("/ideas/trending", async (req, res) => {
      try {
        const trendingideas = await ideacollection
          .find()
          .sort({ commentCount: -1 }) 
          .limit(6)                  
          .toArray();                
        res.send(trendingideas);
      } catch (error) {
        console.error("Trending analytics extraction drop:", error);
        res.status(500).send({ message: "Failed to load trending items", error });
      }
    });

    
    app.post("/ideas", async (req, res) => {
      try {
        const payloadData = req.body;

        
        const customIdeaDocument = {
          ideaTitle: payloadData.title || payloadData.ideaTitle, 
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
          error 
        });
      }
    });

  } catch (error) {
    console.error(" Database connection structural failure:", error);
  }
}


runServer().catch(console.dir);

app.listen(port, () => {
  console.log(` IdeaVault Express server active on local port: ${port}`);
});