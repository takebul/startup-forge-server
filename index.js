const dns = require("node:dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dotenv.config();

const uri = process.env.MONGODB_URI;

const app = express();
const PORT = process.env.PORT;

app.use(
  cors({
    credentials: true,
    origin: [process.env.CLIENT_URL],
  }),
);
app.use(express.json());

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db(process.env.DB_NAME);
    const paymentsCollection = db.collection("payments");
    const userCollection = db.collection("user");
    const startupsCollection = db.collection("startups");
    const opportunitiesCollection = db.collection("opportunities");

    app.post("/api/payments", async (req, res) => {
      const { user, session_id } = req.body;

      const isExistSession = await paymentsCollection.findOne({ session_id });
      if (isExistSession) {
        return res.status(400).send({ message: "Session already exist" });
      }

      const payment_result = await paymentsCollection.insertOne({
        userId: new ObjectId(user?.id),
        session_id,
      });

      const user_result = await userCollection.updateOne(
        { _id: new ObjectId(user.id) },
        { $set: { plan: "pro" } },
      );

      res.send({ payment_result, user_result });
    });

    app.post("/api/startup", async (req, res) => {
      const { startupId, startup_name } = req.body;

      const data = req.body;

      const startup_result = await startupsCollection.insertOne(data);

      const opportunity_result = await opportunitiesCollection.updateOne(
        { startupId: startupId },
        { $set: { startupId: startup_name } },
      );

      res.send({ startup_result, opportunity_result });
    });

    app.patch("/api/startup/:id", async (req, res) => {
      const { id } = req.params;
      const { _id, ...updateStartup } = req.body;

      const startup_result = await startupsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateStartup },
      );

      res.send(startup_result || {});
    });

    app.delete("/api/startup/:id", async (req, res) => {
      const { id } = req.params;
      const result = await startupsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result || {});
    });

    app.get("/api/my/startups", async (req, res) => {
      const query = {};

      if (req.query.startupId) {
        query.startupId = req.query.startupId;
      }

      const startup_result = await startupsCollection.find(query).toArray();
      res.send(startup_result || {});
    });

    app.get("/api/startup/:id", async (req, res) => {
      const { id } = req.params;
      const result = await startupsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result || {});
    });

    // ---------------------

    app.post("/api/opportunity", async (req, res) => {
      const data = req.body;

      const result = await opportunitiesCollection.insertOne({ ...data });
      res.send(result || {});
    });

    app.get("/api/my/opportunities", async (req, res) => {
      const query = {};

      if (req.query.startupId) {
        query.startupId = req.query.startupId;
      }

      const result = await opportunitiesCollection.find(query).toArray();
      res.send(result || {});
    });

    app.patch("/api/opportunity/:id", async (req, res) => {
      const { id } = req.params;
      const { _id, ...updateOpportunity } = req.body;

      const result = await opportunitiesCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateOpportunity },
      );

      res.send(result || {});
    });

    app.delete("/api/opportunity/:id", async (req, res) => {
      const { id } = req.params;
      const result = await opportunitiesCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result || {});
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running fine!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
