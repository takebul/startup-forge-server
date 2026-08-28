const dns = require("node:dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dotenv.config();

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

// async function run() {
//   try {
//     await client.connect();

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

// Resolve the user's effective role. Mirrors the client's persona logic: an
// admin may be stored with either accountType "admin" or role "admin".
const getUserRole = (user) => {
  if (!user) return null;
  const accountType = String(user.accountType || "").toLowerCase();
  const role = String(user.role || "").toLowerCase();
  if (accountType === "admin" || role === "admin") return "admin";
  if (accountType) return accountType;
  return role || null;
};

// The authenticated user's stable id as a string (matches the startupId / collaboratorId fields)
const userIdStr = (user) => String(user?._id || user?.id || "");

// Require the authenticated user to have one of the given roles.
// IMPORTANT: this must be invoked as requireAnyRole("founder", "admin"), never as
// "verifyA || verifyB" — the || operator returns the first function and silently
// skips every other check, which is how these routes were left wide open before.
const requireAnyRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) {
      return res.status(401).send({ message: "unauthorized access" });
    }
    if (!roles.includes(getUserRole(req.user))) {
      return res.status(403).send({ message: "forbidden access" });
    }
    next();
  };

const verifyFounder = requireAnyRole("founder");
const verifyCollaborator = requireAnyRole("collaborator");
const verifyAdmin = requireAnyRole("admin");

// Fields that must never leave the server inside a user document
const sensitiveUserFields = [
  "password",
  "hashedPassword",
  "passwordHash",
  "token",
  "verificationToken",
  "sessionToken",
  "__v",
];

// Remove sensitive fields from a user document before sending it to a client
const sanitizeUser = (user) => {
  if (!user) return user;
  const safe = { ...user };
  sensitiveUserFields.forEach((field) => delete safe[field]);
  return safe;
};

const sanitizeUsers = (users) =>
  Array.isArray(users) ? users.map(sanitizeUser) : sanitizeUser(users);

// ---------------------------------------------------------------------------
// Founder profile enrichment for public startup / opportunity reads.
//
// The full users collection is admin-only, so public pages can never look up a
// founder there. Instead we denormalise the founder's PUBLIC profile (name,
// image, bio — never password/token/email-only) onto the startup/opportunity
// document. New records are stamped at write time from the session; existing
// records are enriched here at read time from the founder's user document.
// ---------------------------------------------------------------------------

// Copy public founder fields from a user doc onto a startup/opportunity doc.
const enrichFounder = (doc, founderUser) => {
  if (!doc || !founderUser) return doc;
  const safe = { ...doc };
  if (!safe.founder_name && founderUser.name) safe.founder_name = founderUser.name;
  if (!safe.founder_image && founderUser.image) safe.founder_image = founderUser.image;
  if (!safe.founder_bio && founderUser.bio) safe.founder_bio = founderUser.bio;
  if (!safe.founder_email && founderUser.email) safe.founder_email = founderUser.email;
  return safe;
};

// The user id that owns a startup / opportunity document.
const founderIdOf = (doc) =>
  doc && (doc.founderId || doc.startupId || doc.userId || "");

// Enrich a single doc by looking up its founder (best-effort; never throws).
const enrichFounderById = async (doc) => {
  if (!doc) return doc;
  const founderId = founderIdOf(doc);
  if (!founderId || !ObjectId.isValid(founderId)) return doc;
  const founderUser = await usersCollection.findOne({
    _id: new ObjectId(founderId),
  });
  return enrichFounder(doc, founderUser);
};

// Enrich many docs with one batched users lookup (avoids N+1 queries).
const enrichFounders = async (docs) => {
  if (!Array.isArray(docs) || docs.length === 0) return docs;
  const ids = [...new Set(docs.map(founderIdOf).filter(Boolean))].filter((x) =>
    ObjectId.isValid(x),
  );
  if (ids.length === 0) return docs;
  const founderUsers = await usersCollection
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } })
    .toArray();
  const byId = new Map(founderUsers.map((u) => [String(u._id), u]));
  return docs.map((doc) => enrichFounder(doc, byId.get(String(founderIdOf(doc)))));
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

app.post("/api/subscriptions", verifyToken, async (req, res) => {
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

app.get("/api/subscriptions", verifyToken, verifyAdmin, async (req, res) => {
  const result = await paymentsCollection.find().sort({ _id: -1 }).toArray();
  res.send(result);
});

app.get("/api/plans", verifyToken, async (req, res) => {
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
app.post(
  "/api/startup",
  verifyToken,
  requireAnyRole("founder", "admin"),
  async (req, res) => {
    try {
      const data = req.body;
      // The authenticated founder is the owner — never trust the client to pick a startupId
      if (getUserRole(req.user) !== "admin") {
        data.startupId = String(req.user._id);
        data.userId = String(req.user._id);
        // Denormalise the founder's public profile so public pages can render it
        data.founder_name = req.user.name;
        data.founder_image = req.user.image;
        data.founder_email = req.user.email;
      }
      const startupName = data.startup_name || data.name || "Untitled Startup";
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
  },
);

// =========================================================================
// 2. UPDATE / RESUBMIT / APPROVE STARTUP (Bidirectional Notifications)
// =========================================================================
app.patch("/api/startup/:id", verifyToken, async (req, res) => {
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

    // Only the owning founder (or an admin) may edit a startup profile
    const requesterId = userIdStr(req.user);
    const isAdmin = getUserRole(req.user) === "admin";
    const isOwner =
      String(existingStartup.startupId || "") === requesterId ||
      String(existingStartup.userId || "") === requesterId;
    if (!isAdmin && !isOwner) {
      return res.status(403).send({ message: "forbidden access" });
    }

    const startupUpdatePayload = {
      ...updateStartup,
      updatedAt: new Date(),
    };

    // When the owner refreshes their startup, keep the public founder profile in sync
    if (!isAdmin && isOwner) {
      startupUpdatePayload.founder_name = req.user.name;
      startupUpdatePayload.founder_image = req.user.image;
      startupUpdatePayload.founder_email = req.user.email;
    }

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
      } else if (statusLower === "pending" || statusLower === "resubmitted") {
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

    if (statusLower === "resubmitted" || updateStartup.resubmitted === true) {
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

app.delete("/api/startup/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const existingStartup = await startupsCollection.findOne({
    _id: new ObjectId(id),
  });

  if (!existingStartup) {
    return res.status(404).send({ message: "Startup profile not found" });
  }

  // Only the owning founder (or an admin) may delete a startup profile
  const requesterId = userIdStr(req.user);
  const isAdmin = getUserRole(req.user) === "admin";
  const isOwner =
    String(existingStartup.startupId || "") === requesterId ||
    String(existingStartup.userId || "") === requesterId;
  if (!isAdmin && !isOwner) {
    return res.status(403).send({ message: "forbidden access" });
  }

  const result = await startupsCollection.deleteOne({
    _id: new ObjectId(id),
  });
  res.send(result || {});
});

app.get("/api/my/startup", verifyToken, verifyFounder, async (req, res) => {
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

    const data = await enrichFounders(await cursor.toArray());

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
  const data = await enrichFounders(
    await startupsCollection
      .find()
      .sort({ _id: -1 })
      .limit(5)
      .toArray(),
  );
  res.send(data || {});
});

app.get("/api/startup/:id", async (req, res) => {
  const { id } = req.params;
  const result = await enrichFounderById(
    await startupsCollection.findOne({
      _id: new ObjectId(id),
    }),
  );
  res.send(result || {});
});

// =========================================================================
// 1. OPPORTUNITIES
// =========================================================================
app.post(
  "/api/opportunity",
  verifyToken,
  requireAnyRole("founder", "admin"),
  async (req, res) => {
    try {
      const data = req.body;

      // The authenticated founder owns every role they post
      if (getUserRole(req.user) !== "admin") {
        data.startupId = String(req.user._id);
        // Denormalise the founder's public profile so public pages can render it
        data.founder_name = req.user.name;
        data.founder_image = req.user.image;
        data.founder_email = req.user.email;
      }

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
  },
);

app.patch("/api/opportunity/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { _id, ...updateOpportunity } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid Opportunity ID" });
    }

    const existingOpp = await opportunitiesCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!existingOpp) {
      return res.status(404).json({ error: "Opportunity not found" });
    }

    // Only the founder who owns the opportunity (or an admin) may edit it
    const isAdmin = getUserRole(req.user) === "admin";
    const isOwner = String(existingOpp.startupId || "") === userIdStr(req.user);
    if (!isAdmin && !isOwner) {
      return res.status(403).send({ message: "forbidden access" });
    }

    const result = await opportunitiesCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          ...updateOpportunity,
          // Keep the public founder profile in sync on owner edits
          ...(!isAdmin && isOwner
            ? {
                founder_name: req.user.name,
                founder_image: req.user.image,
                founder_email: req.user.email,
              }
            : {}),
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

app.delete("/api/opportunity/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const existingOpp = await opportunitiesCollection.findOne({
    _id: new ObjectId(id),
  });

  if (!existingOpp) {
    return res.status(404).send({ message: "Opportunity not found" });
  }

  // Only the founder who owns the opportunity (or an admin) may delete it
  const isAdmin = getUserRole(req.user) === "admin";
  const isOwner = String(existingOpp.startupId || "") === userIdStr(req.user);
  if (!isAdmin && !isOwner) {
    return res.status(403).send({ message: "forbidden access" });
  }

  const result = await opportunitiesCollection.deleteOne({
    _id: new ObjectId(id),
  });
  res.send(result || {});
});

app.get(
  "/api/my/opportunities",
  verifyToken,
  verifyFounder,
  async (req, res) => {
    const query = {};
    if (req.query.startupId) {
      query.startupId = req.query.startupId;
    }
    const result = await opportunitiesCollection
      .find(query)
      .sort({ _id: -1 })
      .toArray();
    res.send(result || {});
  },
);

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
                $in: matchedStartupNames.map((n) => new RegExp(`^${n}$`, "i")),
              },
            },
            { industry: { $in: industryRegexes } },
          ],
        });
      }
    }

    const query = queryConditions.length > 0 ? { $and: queryConditions } : {};

    const total_data = await opportunitiesCollection.countDocuments(query);
    const total_page = Math.ceil(total_data / limit) || 1;
    const skip = (page - 1) * limit;

    const data = await enrichFounders(
      await opportunitiesCollection
        .find(query)
        .skip(skip)
        .limit(limit)
        .sort({ _id: -1 })
        .toArray(),
    );

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

    const result = await enrichFounderById(
      await opportunitiesCollection.findOne({
        _id: new ObjectId(id),
      }),
    );

    res.send(result || {});
  } catch (error) {
    console.error("Error fetching opportunity details:", error);
    res.status(500).send({ error: error.message });
  }
});

app.get("/api/featured/opportunities", async (req, res) => {
  const data = await enrichFounders(
    await opportunitiesCollection
      .find()
      .sort({ _id: -1 })
      .limit(5)
      .toArray(),
  );
  res.send(data || {});
});

// =========================================================================
// 3. APPLICATIONS (Collaborator Applies -> Notifies Founder)
// =========================================================================
app.post(
  "/api/application",
  verifyToken,
  verifyCollaborator,
  async (req, res) => {
    try {
      const data = req.body;
      // The authenticated collaborator is the applicant — never trust the client
      data.collaboratorId = String(req.user._id);
      data.userId = String(req.user._id);
      data.applicantEmail = req.user.email;
      data.applicantName = req.user.name;
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
  },
);

// =========================================================================
// 3. UPDATE APPLICATION (Founder Accepts/Rejects -> Notifies Collaborator)
// =========================================================================
app.patch(
  "/api/application/:id",
  verifyToken,
  requireAnyRole("founder", "admin"),
  async (req, res) => {
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

      // Only the founder who owns the startup (or an admin) may decide an application
      const isAdmin = getUserRole(req.user) === "admin";
      const isOwner =
        String(existingApp.startupId || "") === userIdStr(req.user);
      if (!isAdmin && !isOwner) {
        return res.status(403).send({ message: "forbidden access" });
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
  },
);

app.get(
  "/api/founder/applications",
  verifyToken,
  verifyFounder,
  async (req, res) => {
    // A founder may only ever see applications for their own startup
    const requestedStartupId = req.query.startupId || userIdStr(req.user);
    if (req.user._id.toString() !== requestedStartupId) {
      return res.status(403).send({ message: "forbidden access" });
    }

    const query = { startupId: requestedStartupId };

    const result = await applicationsCollection
      .find(query)
      .sort({ _id: -1 })
      .toArray();
    res.send(result || {});
  },
);

app.get(
  "/api/my/applications",
  verifyToken,
  requireAnyRole("collaborator", "admin"),
  async (req, res) => {
    try {
      const { collaboratorId, userId, opportunityId } = req.query;
      const query = {};

      // A user may only ever look up their OWN applications (admin may look up any).
      // This blocks the IDOR where a collaborator passed someone else's id.
      const activeUserId = collaboratorId || userId || userIdStr(req.user);
      const requesterId = userIdStr(req.user);
      const isAdmin = getUserRole(req.user) === "admin";
      if (
        !isAdmin &&
        activeUserId !== requesterId &&
        activeUserId !== String(req.user.id || "")
      ) {
        return res.status(403).send({ message: "forbidden access" });
      }
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
  },
);

app.delete("/api/application/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const existingApp = await applicationsCollection.findOne({
    _id: new ObjectId(id),
  });

  if (!existingApp) {
    return res.status(404).send({ message: "Application not found" });
  }

  // The owning collaborator, the receiving founder, or an admin may delete an application
  const requesterId = userIdStr(req.user);
  const isAdmin = getUserRole(req.user) === "admin";
  const isOwner =
    String(existingApp.collaboratorId || "") === requesterId ||
    String(existingApp.userId || "") === requesterId ||
    String(existingApp.startupId || "") === requesterId;
  if (!isAdmin && !isOwner) {
    return res.status(403).send({ message: "forbidden access" });
  }

  const result = await applicationsCollection.deleteOne({
    _id: new ObjectId(id),
  });
  res.send(result || {});
});

// =========================================================================
// BOOKMARKS
// =========================================================================
app.post("/api/bookmark", verifyToken, async (req, res) => {
  try {
    const {
      opportunityId,
      roleTitle,
      startupName,
      workType,
      commitmentLevel,
      deadline,
      requiredSkills,
    } = req.body;

    if (!opportunityId) {
      return res.status(400).json({ error: "opportunityId is required" });
    }

    // The authenticated user owns the bookmark — never trust the client to pick an owner
    const oppIdStr = String(opportunityId);
    const ownerUserIdStr = userIdStr(req.user);

    const existing = await bookmarksCollection.findOne({
      opportunityId: oppIdStr,
      userId: ownerUserIdStr,
    });

    if (existing) {
      return res.json(existing);
    }

    const bookmarkData = {
      opportunityId: oppIdStr,
      userId: ownerUserIdStr,
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

app.delete("/api/bookmark/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const requesterId = userIdStr(req.user);
    const isAdmin = getUserRole(req.user) === "admin";

    // Scope the lookup to the authenticated user (unless admin). Multiple
    // users can bookmark the same opportunity, so matching by opportunityId
    // alone could select another user's bookmark and wrongly 403 / delete it.
    const userScope = isAdmin ? {} : { userId: requesterId };

    const bookmark = await bookmarksCollection.findOne({
      $or: [
        { opportunityId: String(id), ...userScope },
        ...(ObjectId.isValid(id)
          ? [{ _id: new ObjectId(id), ...userScope }]
          : []),
      ],
    });

    if (!bookmark) {
      return res.status(404).json({ error: "Bookmark not found" });
    }

    // Only the owner (or an admin) may remove a bookmark
    if (!isAdmin && String(bookmark.userId || "") !== requesterId) {
      return res.status(403).send({ message: "forbidden access" });
    }

    const result = await bookmarksCollection.deleteOne({
      _id: bookmark._id,
    });
    res.json(result);
  } catch (error) {
    console.error("Error deleting bookmark:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get(
  "/api/my/bookmarks",
  verifyToken,
  requireAnyRole("collaborator", "admin"),
  async (req, res) => {
    try {
      const { userId } = req.query;

      // A user may only read their own bookmarks (admin may read any)
      const activeUserId = userId || userIdStr(req.user);
      const requesterId = userIdStr(req.user);
      const isAdmin = getUserRole(req.user) === "admin";
      if (
        !isAdmin &&
        activeUserId !== requesterId &&
        activeUserId !== String(req.user.id || "")
      ) {
        return res.status(403).send({ message: "forbidden access" });
      }

      const result = await bookmarksCollection
        .find({ userId: String(activeUserId) })
        .sort({ _id: -1 })
        .toArray();

      res.json(result || []);
    } catch (error) {
      console.error("Error fetching bookmarks:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// =========================================================================
// USERS
// =========================================================================
app.get(
  "/api/user/profile/:id",
  verifyToken,
  requireAnyRole("admin", "founder", "collaborator"),
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ error: "Invalid User ID" });
    }

    // A user may only read their own profile (admin may read any)
    const requesterId = userIdStr(req.user);
    const isAdmin = getUserRole(req.user) === "admin";
    const isSelf = id === requesterId || id === String(req.user.id || "");
    if (!isAdmin && !isSelf) {
      return res.status(403).send({ message: "forbidden access" });
    }

    const result = await usersCollection.findOne({ _id: new ObjectId(id) });
    res.send(sanitizeUser(result) || {});
  },
);

app.patch("/api/user/profile/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, image, skills, bio } = req.body;

    // A user may only update their own profile (admin may update any)
    const requesterId = userIdStr(req.user);
    const isAdmin = getUserRole(req.user) === "admin";
    const isSelf = id === requesterId || id === String(req.user.id || "");
    if (!isAdmin && !isSelf) {
      return res.status(403).send({ message: "forbidden access" });
    }

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

app.patch("/api/user/:id", verifyToken, verifyAdmin, async (req, res) => {
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
  res.send(sanitizeUsers(result) || {});
});

// =========================================================================
// 4. NOTIFICATIONS ENDPOINTS
// =========================================================================
app.get("/api/notifications", verifyToken, async (req, res) => {
  try {
    const { userId, role } = req.query;
    let query = {};

    // A user may only read their own notifications; only an admin may see admin-wide ones
    const requesterId = userIdStr(req.user);
    const isAdmin = getUserRole(req.user) === "admin";
    if (!isAdmin && String(userId || "") !== requesterId) {
      return res.status(403).send({ message: "forbidden access" });
    }
    const effectiveUserId = userId || requesterId;

    if (role === "admin" && isAdmin) {
      query = {
        $or: [
          { recipientRole: "admin" },
          { recipientId: String(effectiveUserId) },
        ],
      };
    } else {
      query = { recipientId: String(effectiveUserId) };
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

app.patch("/api/notifications/mark-all-read", verifyToken, async (req, res) => {
  try {
    const { userId, role } = req.body;
    let query = {};

    // A user may only mark their own notifications read
    const requesterId = userIdStr(req.user);
    const isAdmin = getUserRole(req.user) === "admin";
    if (!isAdmin && String(userId || "") !== requesterId) {
      return res.status(403).send({ message: "forbidden access" });
    }
    const effectiveUserId = userId || requesterId;

    if (role === "admin" && isAdmin) {
      query = {
        $or: [
          { recipientRole: "admin" },
          { recipientId: String(effectiveUserId) },
        ],
      };
    } else {
      query = { recipientId: String(effectiveUserId) };
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

app.patch("/api/notifications/:id/read", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid Notification ID" });
    }

    const notif = await notificationsCollection.findOne({
      _id: new ObjectId(id),
    });
    if (!notif) {
      return res.status(404).json({ error: "Notification not found" });
    }

    // A user may only mark their own notifications read (admin may mark any)
    const requesterId = userIdStr(req.user);
    const isAdmin = getUserRole(req.user) === "admin";
    if (!isAdmin && String(notif.recipientId || "") !== requesterId) {
      return res.status(403).send({ message: "forbidden access" });
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

//     await client.db("admin").command({ ping: 1 });
//     console.log(
//       "Pinged your deployment. You successfully connected to MongoDB!",
//     );
//   } finally {
//     // Keep connection alive
//     // await client.close()
//   }
// }
// run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("StartupForge server is running fine!");
});

app.listen(PORT, () => {
  console.log(`StartupForge server running on port ${PORT}`);
});
