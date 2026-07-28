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

    app.post("/api/payments", async (req, res) => {
      const { user, session_id } = req.body;

      const isExistSession = await paymentsCollection.findOne({ session_id });
      if (isExistSession) {
        return res.status(400).send({ message: "Session already exist" });
      }

      const payment_result = await paymentsCollection.insertOne({
        userId: new ObjectId(user.id),
        session_id,
      });

      const user_result = await userCollection.updateOne(
        { _id: new ObjectId(user.id) },
        { $set: { plan: "pro" } },
      );

      res.send({ payment_result, user_result });
    });

    app.post("/api/startup", async (req, res) => {
      const data = req.body;

      const result = await startupsCollection.insertOne(data);
      res.send(result);
    });

    app.get("/api/startups", async (req, res) => {
      const result = await startupsCollection.find().toArray();
      res.send(result);
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
