const dns = require("dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;


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
          
        res.send(trendingideas);
      } catch (error) {
        res.status(500).send({ message: "Failed to load trending items", error });
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