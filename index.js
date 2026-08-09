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
    const paymentsCollection = db.collection("subscriptions");
    const usersCollection = db.collection("user");
    const startupsCollection = db.collection("startups");
    const opportunitiesCollection = db.collection("opportunities");
    const applicationsCollection = db.collection("applications");
    const bookmarksCollection = db.collection("bookmarks");
    const plansCollection = db.collection("plans");

    app.post("/api/subscriptions", async (req, res) => {
      const { subsInfo } = req.body;

      const isExistSession = await paymentsCollection.findOne({
        "subsInfo.session_id": subsInfo.session_id,
      });

      if (isExistSession) {
        return res.status(400).send({ message: "Session already exist" });
      }

      const subscription_result = await paymentsCollection.insertOne({
        ...subsInfo,
        createdAt: new Date(),
      });

      const filter = { email: subsInfo.email };

      const updateDocument = {
        $set: {
          plan: subsInfo.planId,
        },
      };

      const update_user_result = await usersCollection.updateOne(
        filter,
        updateDocument,
      );

      res.send({ subscription_result, update_user_result });
    });

    // plans
    app.get("/api/plans", async (req, res) => {
      const query = {};
      if (req.query.plan_id) {
        query.plan_id = req.query.plan_id;
      }
      const result = await plansCollection.findOne(query);
      res.send(result);
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
            { $set: { startupName: startupName, status: "Pending" } },
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

    app.get("/api/my/startup", async (req, res) => {
      const query = {};

      if (req.query.startupId) {
        query.startupId = req.query.startupId;
      }

      const startup_result = await startupsCollection.find(query).toArray();
      res.send(startup_result || {});
    });

    app.get("/api/startups", async (req, res) => {
      const result = await startupsCollection
        .find()
        .sort({ _id: -1 })
        .toArray();
      res.send(result || {});
    });

    app.get("/api/startup/:id", async (req, res) => {
      const { id } = req.params;
      const result = await startupsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result || {});
    });

    // ---------------------
    // opportunities
    // ------------------

    app.post("/api/opportunity", async (req, res) => {
      const data = req.body;

      const result = await opportunitiesCollection.insertOne({ ...data });
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

    app.get("/api/opportunities", async (req, res) => {
      try {
        const result = await opportunitiesCollection
          .find()
          .sort({ _id: -1 })
          .toArray();
        res.send(result || []);
      } catch (error) {
        console.error("Error fetching opportunities:", error);
        res.status(500).send({ error: error.message });
      }
    });

    app.get("/api/opportunity/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ error: "Invalid Opportunity ID" });
        }

        const result = await opportunitiesCollection.findOne({
          _id: new ObjectId(id),
        });

        res.send(result || {});
      } catch (error) {
        console.error("Error fetching opportunity details:", error);
        res.status(500).send({ error: error.message });
      }
    });

    // ------------------
    // applications
    //---------------

    app.post("/api/application", async (req, res) => {
      try {
        const data = req.body;
        const newApplication = {
          ...data,
          status: "Pending",
          appliedDate: new Date().toISOString().split("T")[0],
        };

        const result = await applicationsCollection.insertOne(newApplication);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error submitting application:", error);
        res.status(500).send({ error: error.message });
      }
    });

    app.patch("/api/application/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body; // Extract status from request body

        if (!status) {
          return res.status(400).send({ error: "Status is required" });
        }

        const result = await applicationsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } },
        );

        res.send(result || {});
      } catch (err) {
        console.error("Error updating application status:", err);
        res.status(500).send({ error: err.message });
      }
    });

    // ___ GET APPLICATIONS
    app.get("/api/founder/applications", async (req, res) => {
      const query = {};

      if (req.query.startupId) {
        query.startupId = req.query.startupId;
      }

      const result = await applicationsCollection
        .find(query)
        .sort({ _id: -1 })
        .toArray();
      res.send(result || {});
    });

    // ─── 3. GET MY APPLICATIONS
    app.get("/api/my/applications", async (req, res) => {
      try {
        const { collaboratorId, userId, opportunityId } = req.query;
        const query = {};

        // Filter by user ID
        const activeUserId = collaboratorId || userId;
        if (activeUserId) {
          query.$or = [
            { collaboratorId: activeUserId },
            { userId: activeUserId },
          ];
        }

        // FIX: Changed applicationId -> opportunityId
        if (opportunityId) {
          query.opportunityId = opportunityId;
        }

        // MongoDB Aggregation Pipeline ($lookup to join opportunities collection)
        const result = await applicationsCollection
          .aggregate([
            { $match: query },
            {
              $addFields: {
                // Safely convert string opportunityId to ObjectId if valid
                convertedOppId: {
                  $cond: {
                    if: {
                      $and: [
                        { $eq: [{ $type: "$opportunityId" }, "string"] },
                        { $eq: [{ $strLenCP: "$opportunityId" }, 24] },
                      ],
                    },
                    then: { $toObjectId: "$opportunityId" },
                    else: "$opportunityId",
                  },
                },
              },
            },
            {
              $lookup: {
                from: "opportunities",
                localField: "convertedOppId",
                foreignField: "_id",
                as: "opportunityDetails",
              },
            },
            { $sort: { _id: -1 } },
          ])
          .toArray();

        res.send(result || []);
      } catch (error) {
        console.error("Error fetching applications:", error);
        res.status(500).send({ error: error.message });
      }
    });

    app.delete("/api/application/:id", async (req, res) => {
      const { id } = req.params;
      const result = await applicationsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result || {});
    });

    // ─── 1. CREATE BOOKMARK ────────────────────────────────────────────────────────
    app.post("/api/bookmark", async (req, res) => {
      try {
        const {
          opportunityId,
          userId,
          roleTitle,
          startupName,
          workType,
          commitmentLevel,
          deadline,
          requiredSkills,
        } = req.body;

        if (!opportunityId || !userId) {
          return res
            .status(400)
            .json({ error: "opportunityId and userId are required" });
        }

        const oppIdStr = String(opportunityId);
        const userIdStr = String(userId);

        // Check if bookmark already exists
        const existing = await bookmarksCollection.findOne({
          opportunityId: oppIdStr,
          userId: userIdStr,
        });

        if (existing) {
          return res.json(existing);
        }

        // Insert rich bookmark document
        const bookmarkData = {
          opportunityId: oppIdStr,
          userId: userIdStr,
          roleTitle: roleTitle || "Collaborator Role",
          startupName: startupName || "Startup",
          workType: workType || "Remote",
          commitmentLevel: commitmentLevel || "Part-Time",
          deadline: deadline || "N/A",
          requiredSkills: Array.isArray(requiredSkills) ? requiredSkills : [],
          createdAt: new Date(),
        };

        const result = await bookmarksCollection.insertOne(bookmarkData);
        res.status(201).json(result);
      } catch (error) {
        console.error("Error creating bookmark:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // ─── 2. DELETE BOOKMARK ────────────────────────────────────────────────────────
    app.delete("/api/bookmark/:id", async (req, res) => {
      try {
        const { id } = req.params; // opportunityId
        const { userId } = req.query;

        const query = {
          $or: [
            { opportunityId: String(id) },
            ...(ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : []),
          ],
        };

        if (userId) {
          query.userId = String(userId);
        }

        const result = await bookmarksCollection.deleteOne(query);
        res.json(result);
      } catch (error) {
        console.error("Error deleting bookmark:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // ─── 3. GET USER BOOKMARKS ────────────────────────────────────────────────────
    app.get("/api/my/bookmarks", async (req, res) => {
      try {
        const { userId } = req.query;

        if (!userId) {
          return res.json([]);
        }

        const result = await bookmarksCollection
          .find({ userId: String(userId) })
          .sort({ _id: -1 })
          .toArray();

        res.json(result || []);
      } catch (error) {
        console.error("Error fetching bookmarks:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // ----------------
    // user
    // ------------

    app.get("/api/user/profile/:id", async (req, res) => {
      const { id } = req.params;
      const result = await usersCollection.findOne({ _id: new ObjectId(id) });
      res.send(result || {});
    });

    app.patch("/api/user/profile/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { name, image, skills, bio } = req.body;

        const updateFields = {
          updatedAt: new Date(),
        };

        if (name) updateFields.name = name;
        if (image) updateFields.image = image;
        if (skills !== undefined) updateFields.skills = skills;
        if (bio !== undefined) updateFields.bio = bio;

        const query = {
          $or: [
            ...(ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : []),
            { id: id },
            { userId: id },
          ],
        };

        const result = await usersCollection.updateOne(query, {
          $set: updateFields,
        });

        res.json({ success: true, result });
      } catch (error) {
        console.error("Error updating user profile:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.patch("/api/user/:id", async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } },
      );

      res.send(result || {});
    });

    app.get("/api/users", async (req, res) => {
      const result = await usersCollection.find().sort({ _id: -1 }).toArray();
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
