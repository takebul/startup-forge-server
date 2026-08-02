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

    // ---------------------------------------------------------------------------
    // 1. CREATE STARTUP
    // ---------------------------------------------------------------------------
    app.post("/api/startup", async (req, res) => {
      try {
        const data = req.body;
        const startupName = data.startup_name || data.name;
        const startupId = data.startupId || data.userId;

        const startup_result = await startupsCollection.insertOne(data);

        // Update ALL matching opportunities if startupName exists
        let opportunity_result = null;
        if (startupId && startupName) {
          opportunity_result = await opportunitiesCollection.updateMany(
            { startupId: startupId },
            { $set: { startupName: startupName } },
          );
        }

        res.status(201).json({ startup_result, opportunity_result });
      } catch (error) {
        console.error("Error creating startup:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // ---------------------------------------------------------------------------
    // 2. UPDATE STARTUP (Updates startup & syncs startupName in all opportunities)
    // ---------------------------------------------------------------------------
    app.patch("/api/startup/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { _id, ...updateStartup } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid Startup ID" });
        }

        // 1. Update startup document
        const startup_result = await startupsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateStartup },
        );

        // 2. Extract updated name
        const updatedName = updateStartup.startup_name || updateStartup.name;

        // 3. Use updateMany and match startupId using string ID or ObjectId
        let update_opportunities = null;
        if (updatedName) {
          update_opportunities = await opportunitiesCollection.updateMany(
            {
              $or: [
                { startupId: id },
                { startupId: new ObjectId(id) },
                ...(updateStartup.startupId
                  ? [{ startupId: updateStartup.startupId }]
                  : []),
              ],
            },
            { $set: { startupName: updatedName } },
          );
        }

        console.log(
          "Updated opportunities count:",
          update_opportunities?.modifiedCount,
        );

        res.json({ startup_result, update_opportunities });
      } catch (error) {
        console.error("Error updating startup:", error);
        res.status(500).json({ error: error.message });
      }
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

      const startup_result = await startupsCollection
        .find(query)
        .sort({ _id: -1 })
        .toArray();
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

      const result = await opportunitiesCollection
        .find(query)
        .sort({ _id: -1 })
        .toArray();
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
