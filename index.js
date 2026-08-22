const dns = require("node:dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dotenv.config();

const logger = (req, res, next) => {
  console.log("logger middleware logged", req.params);
  next();
};

const uri = process.env.MONGODB_URI;

const app = express();
const PORT = process.env.PORT || 5000;

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
    const sessionCollection = db.collection("session");
    const notificationsCollection = db.collection("notifications");

    // =========================================================================
    // REUSABLE NOTIFICATION HELPER FUNCTION
    // =========================================================================
    const createSystemNotification = async ({
      recipientId = null,
      recipientRole = "founder",
      message,
      type = "info",
      link = "",
    }) => {
      try {
        const doc = {
          recipientId: recipientId ? String(recipientId) : null,
          recipientRole,
          message,
          type,
          link,
          isRead: false,
          createdAt: new Date(),
        };
        return await notificationsCollection.insertOne(doc);
      } catch (err) {
        console.error("Error creating notification:", err);
      }
    };

    // =========================================================================
    // AUTHENTICATION & ROLE VERIFICATION MIDDLEWARES
    // =========================================================================
    const verifyToken = async (req, res, next) => {
      const authHeader = req.headers?.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      const session = await sessionCollection.findOne({ token: token });
      if (!session) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      const user = await usersCollection.findOne({ _id: session?.userId });
      if (!user) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      req.user = user;
      next();
    };

    const verifyFounder = async (req, res, next) => {
      if (req.user?.accountType !== "founder") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    const verifyCollaborator = async (req, res, next) => {
      if (req.user?.accountType !== "collaborator") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    const verifyAdmin = async (req, res, next) => {
      if (req.user?.accountType !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // =========================================================================
    // SUBSCRIPTIONS & PLANS
    // =========================================================================
    // Helper to format plan IDs into readable titles
    const formatPlanName = (planId) => {
      if (!planId) return "Subscription Plan";
      return String(planId)
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
    };

    app.post("/api/subscriptions", async (req, res) => {
      try {
        const { subsInfo, user } = req.body;

        const isExistSession = await paymentsCollection.findOne({
          "subsInfo.session_id": subsInfo.session_id,
        });

        if (isExistSession) {
          return res.status(400).send({ message: "Session already exists" });
        }

        const subscription_result = await paymentsCollection.insertOne({
          ...subsInfo,
          user: user?.name,
          subscriptionAt: new Date(),
        });

        const update_user_result = await usersCollection.updateOne(
          { email: subsInfo.email },
          { $set: { plan: subsInfo.planId } },
        );

        const subscriberName =
          user?.name || subsInfo.name || subsInfo.email || "A user";
        const planTitle = formatPlanName(subsInfo.planId);
        const formattedAmount = subsInfo.amount
          ? `$${(subsInfo.amount / 100).toFixed(0)}`
          : "";

        // 🔥 Send notification with the correct transactions route
        await createSystemNotification({
          recipientRole: "admin",
          message: `💳 Subscription Activated: ${subscriberName} upgraded to ${planTitle}${
            formattedAmount ? ` (${formattedAmount})` : ""
          }.`,
          type: "subscription",
          link: "/dashboard/admin/transactions", // Updated to existing transactions route
        });

        res.send({ subscription_result, update_user_result });
      } catch (error) {
        console.error("Error processing subscription:", error);
        res
          .status(500)
          .send({ error: error.message || "Failed to process subscription" });
      }
    });

    app.get("/api/subscriptions", async (req, res) => {
      const result = await paymentsCollection
        .find()
        .sort({ _id: -1 })
        .toArray();
      res.send(result);
    });

    app.get("/api/plans", async (req, res) => {
      const query = {};
      if (req.query.plan_id) {
        query.plan_id = req.query.plan_id;
      }
      const result = await plansCollection.findOne(query);
      res.send(result);
    });

    // =========================================================================
    // 1. CREATE STARTUP (Founder Submits -> Notifies Admin)
    // =========================================================================
    app.post("/api/startup", async (req, res) => {
      try {
        const data = req.body;
        const startupName =
          data.startup_name || data.name || "Untitled Startup";
        const startupId = data.startupId || data.userId;
        const founderEmail =
          data.founder_email || data.founderEmail || "A founder";

        const startup_result = await startupsCollection.insertOne({
          ...data,
          status: data.status || "Pending",
          createdAt: new Date(),
        });

        let opportunity_result = null;
        if (startupId && startupName) {
          opportunity_result = await opportunitiesCollection.updateMany(
            { startupId: startupId },
            { $set: { startupName: startupName, status: "Pending" } },
          );
        }

        // Send notification to admin panel
        await createSystemNotification({
          recipientRole: "admin",
          message: `🚀 New Startup Profile: '${startupName}' submitted by ${founderEmail} requires review.`,
          type: "warning",
          link: "/dashboard/admin/startups",
        });

        res.status(201).json({ startup_result, opportunity_result });
      } catch (error) {
        console.error("Error creating startup:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // =========================================================================
    // 2. UPDATE / RESUBMIT / APPROVE STARTUP (Bidirectional Notifications)
    // =========================================================================
    app.patch("/api/startup/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { _id, ...updateStartup } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid Startup ID" });
        }

        const existingStartup = await startupsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!existingStartup) {
          return res.status(404).json({ error: "Startup profile not found" });
        }

        const startupUpdatePayload = {
          ...updateStartup,
          updatedAt: new Date(),
        };

        const startup_result = await startupsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: startupUpdatePayload },
        );

        const updatedName =
          updateStartup.startup_name ||
          updateStartup.name ||
          existingStartup.startup_name;
        const customStartupId =
          updateStartup.startupId || existingStartup?.startupId;
        const updatedIndustry = updateStartup.industry;
        const updatedLogo = updateStartup.logo;
        const updatedStatus = updateStartup.status;
        const founderRecipientId =
          existingStartup.startupId ||
          existingStartup.userId ||
          existingStartup._id;
        const founderEmail =
          updateStartup.founder_email ||
          existingStartup.founder_email ||
          "A founder";

        const opportunitySet = {
          updatedAt: new Date(),
        };

        if (updatedName) opportunitySet.startupName = updatedName;
        if (updatedIndustry) opportunitySet.industry = updatedIndustry;
        if (updatedLogo) opportunitySet.startupLogo = updatedLogo;

        if (updatedStatus !== undefined) {
          opportunitySet.startupStatus = updatedStatus;
          const statusLower = String(updatedStatus).toLowerCase();

          if (statusLower === "approved" || updatedStatus === true) {
            opportunitySet.status = "Active";
          } else if (
            statusLower === "rejected" ||
            statusLower === "removed" ||
            statusLower === "declined"
          ) {
            opportunitySet.status = "Closed";
          } else if (
            statusLower === "pending" ||
            statusLower === "resubmitted"
          ) {
            opportunitySet.status = "Pending";
          }
        }

        let update_opportunities = null;
        const oppMatchConditions = [
          { startupId: id },
          { startupId: new ObjectId(id) },
          ...(existingStartup?.startup_name
            ? [{ startupName: existingStartup.startup_name }]
            : []),
          ...(customStartupId ? [{ startupId: customStartupId }] : []),
          ...(customStartupId && ObjectId.isValid(customStartupId)
            ? [{ startupId: new ObjectId(customStartupId) }]
            : []),
        ];

        if (Object.keys(opportunitySet).length > 1) {
          update_opportunities = await opportunitiesCollection.updateMany(
            { $or: oppMatchConditions },
            { $set: opportunitySet },
          );
        }

        // Notification Triggers
        const statusLower = String(updatedStatus || "").toLowerCase();

        if (
          statusLower === "resubmitted" ||
          updateStartup.resubmitted === true
        ) {
          // Founder resubmits -> Notify Admin
          await createSystemNotification({
            recipientRole: "admin",
            message: `🔄 Resubmitted Profile: '${updatedName}' was updated and resubmitted by ${founderEmail} for verification.`,
            type: "resubmitted",
            link: "/dashboard/admin/startups",
          });
        } else if (statusLower === "approved" || updatedStatus === true) {
          // Admin approves -> Notify Founder
          await createSystemNotification({
            recipientId: founderRecipientId,
            recipientRole: "founder",
            message: `🎉 Great news! Your startup profile for '${updatedName}' has been approved by Admin! Your open roles are now active.`,
            type: "success",
            link: "/dashboard/founder/my-startup",
          });
        } else if (
          statusLower === "rejected" ||
          statusLower === "removed" ||
          statusLower === "declined"
        ) {
          // Admin rejects/removes -> Notify Founder
          await createSystemNotification({
            recipientId: founderRecipientId,
            recipientRole: "founder",
            message: `⚠️ Action Required: Your startup profile for '${updatedName}' was declined by Admin. Please update your details and resubmit.`,
            type: "warning",
            link: "/dashboard/founder/my-startup",
          });
        }

        res.json({
          success: true,
          message: "Startup updated and notifications dispatched successfully",
          startup_result,
          update_opportunities,
        });
      } catch (error) {
        console.error("Error updating startup:", error);
        res
          .status(500)
          .json({ error: error.message || "Failed to update startup" });
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
      try {
        const { search = "", industry = "", funding_stage = "" } = req.query;
        const limit = Number(req.query.limit) || 0;
        const page = Number(req.query.page) || 1;

        let query = {};

        if (search.trim()) {
          query.$or = [
            { startup_name: { $regex: search.trim(), $options: "i" } },
            { industry: { $regex: search.trim(), $options: "i" } },
            { description: { $regex: search.trim(), $options: "i" } },
          ];
        }

        if (industry && industry !== "All") {
          const industriesArray = industry
            .split(",")
            .map((ind) => ind.trim())
            .filter(Boolean);

          if (industriesArray.length > 0) {
            query.industry = {
              $in: industriesArray.map((ind) => new RegExp(`^${ind}$`, "i")),
            };
          }
        }

        if (funding_stage && funding_stage !== "All") {
          query.funding_stage = {
            $regex: `^${funding_stage.trim()}$`,
            $options: "i",
          };
        }

        const total_data = await startupsCollection.countDocuments(query);
        const total_page = limit > 0 ? Math.ceil(total_data / limit) : 1;
        const skip = limit > 0 ? (page - 1) * limit : 0;

        const cursor = startupsCollection.find(query).sort({ _id: -1 });
        if (limit > 0) {
          cursor.skip(skip).limit(limit);
        }

        const data = await cursor.toArray();

        if (
          !req.query.page &&
          !req.query.limit &&
          !req.query.industry &&
          !req.query.search
        ) {
          return res.send(data);
        }

        res.send({ data, total_data, total_page, page, startups: data });
      } catch (error) {
        console.error("Error fetching startups:", error);
        res.status(500).send({ error: "Failed to fetch startups" });
      }
    });

    app.get("/api/featured/startups", async (req, res) => {
      const data = await startupsCollection
        .find()
        .sort({ _id: -1 })
        .limit(8)
        .toArray();
      res.send(data || {});
    });

    app.get("/api/startup/:id", async (req, res) => {
      const { id } = req.params;
      const result = await startupsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result || {});
    });

    // =========================================================================
    // 1. OPPORTUNITIES
    // =========================================================================
    app.post("/api/opportunity", async (req, res) => {
      try {
        const data = req.body;

        const newOpportunity = {
          ...data,
          status: data.status || "Active",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await opportunitiesCollection.insertOne(newOpportunity);
        res.status(201).json(result);
      } catch (error) {
        console.error("Error creating opportunity:", error);
        res
          .status(500)
          .json({ error: error.message || "Failed to create opportunity" });
      }
    });

    app.patch("/api/opportunity/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { _id, ...updateOpportunity } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid Opportunity ID" });
        }

        const result = await opportunitiesCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              ...updateOpportunity,
              updatedAt: new Date(),
            },
          },
        );

        res.json({ success: true, result });
      } catch (error) {
        console.error("Error updating opportunity:", error);
        res
          .status(500)
          .json({ error: error.message || "Failed to update opportunity" });
      }
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
        const search = req.query.search || "";
        const workType = req.query.workType || "";
        const industry = req.query.industry || "";
        const limit = Number(req.query.limit) || 9;
        const page = Number(req.query.page) || 1;

        let queryConditions = [];

        if (search.trim()) {
          queryConditions.push({
            $or: [
              { roleTitle: { $regex: search.trim(), $options: "i" } },
              { requiredSkills: { $regex: search.trim(), $options: "i" } },
            ],
          });
        }

        if (workType && workType !== "All") {
          const workTypesArray = workType
            .split(",")
            .map((w) => w.trim())
            .filter(Boolean);

          if (workTypesArray.length > 0) {
            queryConditions.push({
              workType: {
                $in: workTypesArray.map((w) => new RegExp(`^${w}$`, "i")),
              },
            });
          }
        }

        if (industry && industry !== "All") {
          const industriesArray = industry
            .split(",")
            .map((i) => i.trim())
            .filter(Boolean);

          if (industriesArray.length > 0) {
            const industryRegexes = industriesArray.map(
              (ind) => new RegExp(`^${ind}$`, "i"),
            );

            const matchingStartups = await startupsCollection
              .find({ industry: { $in: industryRegexes } })
              .toArray();

            const matchedStartupIds = [];
            const matchedStartupNames = [];

            matchingStartups.forEach((s) => {
              if (s._id) {
                matchedStartupIds.push(s._id.toString());
                matchedStartupIds.push(s._id);
              }
              if (s.startupId) {
                matchedStartupIds.push(s.startupId.toString());
              }
              if (s.startup_name) {
                matchedStartupNames.push(s.startup_name);
              }
              if (s.name) {
                matchedStartupNames.push(s.name);
              }
            });

            queryConditions.push({
              $or: [
                { startupId: { $in: matchedStartupIds } },
                {
                  startupName: {
                    $in: matchedStartupNames.map(
                      (n) => new RegExp(`^${n}$`, "i"),
                    ),
                  },
                },
                { industry: { $in: industryRegexes } },
              ],
            });
          }
        }

        const query =
          queryConditions.length > 0 ? { $and: queryConditions } : {};

        const total_data = await opportunitiesCollection.countDocuments(query);
        const total_page = Math.ceil(total_data / limit) || 1;
        const skip = (page - 1) * limit;

        const data = await opportunitiesCollection
          .find(query)
          .skip(skip)
          .limit(limit)
          .sort({ _id: -1 })
          .toArray();

        res.send({ data, total_page, page, skip, total_data });
      } catch (error) {
        console.error("Error in /api/opportunities:", error);
        res.status(500).send({ error: "Failed to fetch opportunities" });
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

    app.get("/api/featured/opportunities", async (req, res) => {
      const data = await opportunitiesCollection
        .find()
        .sort({ _id: -1 })
        .limit(8)
        .toArray();
      res.send(data || {});
    });

    // =========================================================================
    // 3. APPLICATIONS (Collaborator Applies -> Notifies Founder)
    // =========================================================================
    app.post("/api/application", async (req, res) => {
      try {
        const data = req.body;
        const newApplication = {
          ...data,
          status: "Pending",
          appliedDate: new Date().toISOString().split("T")[0],
          createdAt: new Date(),
        };

        const result = await applicationsCollection.insertOne(newApplication);

        // 🔥 Send notification with the correct founder applications route
        const founderRecipientId = data.startupId || data.founderId;
        const applicantDisplayName =
          data.applicantName || data.applicantEmail || "A collaborator";
        const roleTitle = data.opportunityTitle || "Collaborator Role";

        if (founderRecipientId) {
          await createSystemNotification({
            recipientId: String(founderRecipientId),
            recipientRole: "founder",
            message: `📥 New Application: ${applicantDisplayName} applied for '${roleTitle}'.`,
            type: "info",
            link: "/dashboard/founder/applications", // Updated to /dashboard/founder/applications
          });
        }

        res.status(201).json(result);
      } catch (error) {
        console.error("Error submitting application:", error);
        res
          .status(500)
          .json({ error: error.message || "Failed to submit application" });
      }
    });

    // =========================================================================
    // 3. UPDATE APPLICATION (Founder Accepts/Rejects -> Notifies Collaborator)
    // =========================================================================
    app.patch("/api/application/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid Application ID" });
        }

        if (!status) {
          return res.status(400).json({ error: "Status is required" });
        }

        // 1. Fetch existing application details to identify collaborator and role info
        const existingApp = await applicationsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!existingApp) {
          return res.status(404).json({ error: "Application not found" });
        }

        // 2. Update status in DB
        const result = await applicationsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status,
              updatedAt: new Date(),
            },
          },
        );

        // 3. Extract collaborator and role details
        const collaboratorRecipientId =
          existingApp.collaboratorId || existingApp.userId;
        const roleTitle =
          existingApp.opportunityTitle || existingApp.roleTitle || "Role";
        const startupName = existingApp.startupName || "the startup";
        const normalizedStatus = String(status).toLowerCase();

        // =======================================================================
        // 🔥 NOTIFY COLLABORATOR BASED ON FOUNDER DECISION
        // =======================================================================
        if (collaboratorRecipientId) {
          // CASE A: Founder Accepts Application
          if (
            normalizedStatus === "accepted" ||
            normalizedStatus === "approved"
          ) {
            await createSystemNotification({
              recipientId: String(collaboratorRecipientId),
              recipientRole: "collaborator",
              message: `🎉 Congratulations! Your application for '${roleTitle}' at '${startupName}' was Accepted! Check your dashboard for next steps.`,
              type: "success",
              link: "/dashboard/collaborator/my-applications",
            });
          }
          // CASE B: Founder Rejects Application
          else if (
            normalizedStatus === "rejected" ||
            normalizedStatus === "declined"
          ) {
            await createSystemNotification({
              recipientId: String(collaboratorRecipientId),
              recipientRole: "collaborator",
              message: `📋 Application Update: The team at '${startupName}' decided not to proceed with your application for '${roleTitle}' at this time.`,
              type: "warning",
              link: "/dashboard/collaborator/my-applications",
            });
          }
        }

        res.json({ success: true, result });
      } catch (err) {
        console.error("Error updating application status:", err);
        res
          .status(500)
          .json({ error: err.message || "Failed to update application" });
      }
    });

    app.get(
      "/api/founder/applications",
      verifyToken,
      verifyFounder,
      async (req, res) => {
        const query = {};

        if (req.query.startupId) {
          query.startupId = req.query.startupId;

          if (req.user._id.toString() !== req.query.startupId) {
            return res.status(403).send({ message: "forbidden access" });
          }
        }

        const result = await applicationsCollection
          .find(query)
          .sort({ _id: -1 })
          .toArray();
        res.send(result || {});
      },
    );

    app.get("/api/my/applications", async (req, res) => {
      try {
        const { collaboratorId, userId, opportunityId } = req.query;
        const query = {};

        const activeUserId = collaboratorId || userId;
        if (activeUserId) {
          query.$or = [
            { collaboratorId: activeUserId },
            { userId: activeUserId },
          ];
        }

        if (opportunityId) {
          query.opportunityId = opportunityId;
        }

        const result = await applicationsCollection
          .aggregate([
            { $match: query },
            {
              $addFields: {
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

    // =========================================================================
    // BOOKMARKS
    // =========================================================================
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

        const existing = await bookmarksCollection.findOne({
          opportunityId: oppIdStr,
          userId: userIdStr,
        });

        if (existing) {
          return res.json(existing);
        }

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

    app.delete("/api/bookmark/:id", async (req, res) => {
      try {
        const { id } = req.params;
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

    // =========================================================================
    // USERS
    // =========================================================================
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

    app.get("/api/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().sort({ _id: -1 }).toArray();
      res.send(result || {});
    });

    // =========================================================================
    // 4. NOTIFICATIONS ENDPOINTS
    // =========================================================================
    app.get("/api/notifications", async (req, res) => {
      try {
        const { userId, role } = req.query;
        let query = {};

        if (role === "admin") {
          query = {
            $or: [{ recipientRole: "admin" }, { recipientId: String(userId) }],
          };
        } else {
          query = { recipientId: String(userId) };
        }

        const notifications = await notificationsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .limit(30)
          .toArray();

        const unreadCount = await notificationsCollection.countDocuments({
          ...query,
          isRead: false,
        });

        res.json({ notifications, unreadCount });
      } catch (error) {
        console.error("Failed to fetch notifications:", error);
        res.status(500).json({ error: "Failed to fetch notifications" });
      }
    });

    app.patch("/api/notifications/mark-all-read", async (req, res) => {
      try {
        const { userId, role } = req.body;
        let query = {};

        if (role === "admin") {
          query = {
            $or: [{ recipientRole: "admin" }, { recipientId: String(userId) }],
          };
        } else {
          query = { recipientId: String(userId) };
        }

        const result = await notificationsCollection.updateMany(query, {
          $set: { isRead: true },
        });

        res.json({ success: true, modifiedCount: result.modifiedCount });
      } catch (error) {
        console.error("Failed to mark all as read:", error);
        res.status(500).json({ error: "Failed to update notifications" });
      }
    });

    app.patch("/api/notifications/:id/read", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid Notification ID" });
        }

        const result = await notificationsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isRead: true } },
        );

        res.json({ success: true, modifiedCount: result.modifiedCount });
      } catch (error) {
        console.error("Failed to mark notification as read:", error);
        res.status(500).json({ error: "Failed to update notification" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Keep connection alive
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running fine!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
