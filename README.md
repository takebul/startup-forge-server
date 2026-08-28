<div align="center">

# ⚙️ StartupForge Server

**The REST API backend for StartupForge — the marketplace where startup founders meet world-class collaborators.**

A single-file **Express 5 + MongoDB** API (native driver, no ORM) serving the StartupForge Next.js client: startups, opportunities, applications, bookmarks, Stripe subscriptions, in-app notifications, and role-based user administration.

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express%205-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com)
[![MongoDB](https://img.shields.io/badge/MongoDB-7-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue?style=for-the-badge)](./package.json)
[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on%20Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://vercel.com)

[![Live API](https://img.shields.io/badge/%F0%9F%9A%80_Live_API-startup--forge--server--nine.vercel.app-7C3AED?style=for-the-badge&logo=vercel&logoColor=white)](https://startup-forge-server-nine.vercel.app/)

</div>

---

## ✨ Overview

StartupForge Server is the backend powering the [StartupForge](https://startupforgelimited.vercel.app) platform — a marketplace that connects **founders** (posting startup profiles and open roles) with **collaborators** (applying to those roles and tracking their applications).

It exposes a **REST API** for startup and opportunity listings, an application pipeline with founder-side accept/reject decisions, collaborator bookmarks, Stripe subscription recording, per-user notifications, and an admin console for users, startups, and transactions. The frontend handles session creation (via better-auth); this API **verifies** tokens and enforces role- and ownership-based authorization on every protected route.

---

## 🏗️ Architecture

Honest description: **everything lives in one file** — [`index.js`](index.js) (~1,480 lines). It is organized top-to-bottom as a single Express app with clear sections:

1. **Bootstrap** — a custom DNS resolver (for reliable MongoDB Atlas lookups on serverless), `dotenv`, Express, CORS (single allow-listed origin from env), and JSON body parsing.
2. **Data layer** — one native-driver `MongoClient` (Stable API v1, strict mode) and 9 collection handles.
3. **Shared helpers** — notification writer, auth + role middleware, user sanitizers, and founder-profile enrichment.
4. **Route blocks** — grouped by resource in a consistent order: subscriptions → startups → opportunities → applications → bookmarks → users → notifications. Every group follows the same pattern: `verifyToken` → role guard → **ownership check inside the handler** → query → side effects (notifications).
5. **Health route + `app.listen`**.

Two deliberate engineering decisions stand out:

- **Native MongoDB driver, not Mongoose.** This API is a read-heavy aggregation surface — regex-powered search, multi-field filters, pagination via `countDocuments` + `skip/limit`, and a `$lookup` that joins applications to opportunities so the client renders enriched cards in one request. The driver keeps those pipelines explicit instead of hiding them behind an ODM.
- **Founder profile denormalization.** Public reads of startups/opportunities must not expose the `users` collection, so public founder fields (`name`, `image`, `bio`, `email`) are stamped onto documents at write time and re-synced at read time from the founder's user record — batched into a single `$in` lookup to avoid N+1 queries.

---

## 🛠️ Tech Stack

| Category | Technology |
| --- | --- |
| **Runtime** | [Node.js](https://nodejs.org) (CommonJS) |
| **Framework** | [Express 5](https://expressjs.com) |
| **Database** | [MongoDB](https://www.mongodb.com) 7 native driver (`MongoClient`, Stable API v1, `ObjectId`, aggregation pipeline) |
| **Middleware** | [`cors`](https://github.com/expressjs/cors) (credentials + origin allow-list) · [`express.json`](https://expressjs.com/en/4x/api.html#express.json) body parser |
| **Config** | [`dotenv`](https://github.com/motdotla/dotenv) for environment secrets |
| **Hosting** | [Vercel](https://vercel.com) serverless (`@vercel/node`) |

---

## 📡 API Endpoints

**Auth legend**

| Symbol | Meaning |
| --- | --- |
| 🔓 **Public** | No token required |
| 🪪 **Token** | Any authenticated user (Bearer token, verified server-side) |
| 🏢 / 🤝 / 👑 | Restricted to **Founder** / **Collaborator** / **Admin** roles (admins bypass ownership checks) |

### System

| Method | Route | Description | Auth |
| --- | --- | --- | --- |
| `GET` | `/` | Health check — returns `"StartupForge server is running fine!"` | 🔓 Public |

### Subscriptions & Plans

| Method | Route | Description | Auth |
| --- | --- | --- | --- |
| `POST` | `/api/subscriptions` | Record a Stripe subscription, update the user's `plan`, notify admins. Rejects duplicate `session_id` (idempotency guard). | 🪪 Token |
| `GET` | `/api/subscriptions` | All subscription payments, newest first (admin transactions view). | 👑 Admin |
| `GET` | `/api/plans` | Current plan document; optional `?plan_id=` filter. | 🪪 Token |

### Startups

| Method | Route | Description | Auth |
| --- | --- | --- | --- |
| `POST` | `/api/startup` | Create a startup profile. Founder identity is **stamped server-side** — never trusted from the client. Notifies admins; syncs role names across the founder's opportunities. | 🏢 Founder / 👑 Admin |
| `PATCH` | `/api/startup/:id` | Edit or **resubmit** (owner), or **approve / reject** (admin). Cascades status to related opportunities and dispatches bidirectional notifications (admin ↔ founder). | 🪪 Owner / 👑 Admin |
| `DELETE` | `/api/startup/:id` | Delete a startup profile. | 🪪 Owner / 👑 Admin |
| `GET` | `/api/my/startup` | The authenticated founder's startups; optional `?startupId=` filter. | 🏢 Founder |
| `GET` | `/api/startups` | Search + list. Supports `?search=` (name/industry/description, case-insensitive), `?industry=` (comma-separated), `?funding_stage=`, and `?page=&limit=` pagination with counts. | 🔓 Public |
| `GET` | `/api/featured/startups` | The 5 most recently created startups (homepage strip). | 🔓 Public |
| `GET` | `/api/startup/:id` | Single startup details (validates `ObjectId`). | 🔓 Public |

### Opportunities

| Method | Route | Description | Auth |
| --- | --- | --- | --- |
| `POST` | `/api/opportunity` | Post an open role. Founder identity stamped server-side. | 🏢 Founder / 👑 Admin |
| `PATCH` | `/api/opportunity/:id` | Edit a role (owner only). Keeps public founder profile in sync on owner edits. | 🪪 Owner / 👑 Admin |
| `DELETE` | `/api/opportunity/:id` | Delete a role. | 🪪 Owner / 👑 Admin |
| `GET` | `/api/my/opportunities` | The authenticated founder's roles, newest first; optional `?startupId=` filter. | 🏢 Founder |
| `GET` | `/api/opportunities` | Search + list. Supports `?search=` (title/skills), `?workType=` (Remote/Hybrid/On-site, comma-separated), `?industry=` (resolved against the startups collection), and `?page=&limit=` (default `limit=9`). | 🔓 Public |
| `GET` | `/api/opportunity/:id` | Single opportunity details (validates `ObjectId`). | 🔓 Public |
| `GET` | `/api/featured/opportunities` | The 5 most recently posted roles (homepage strip). | 🔓 Public |

### Applications

| Method | Route | Description | Auth |
| --- | --- | --- | --- |
| `POST` | `/api/application` | Apply to a role. Applicant identity (id/name/email) is **stamped server-side**; notifies the founder. | 🤝 Collaborator |
| `PATCH` | `/api/application/:id` | **Accept / Reject** a candidate. Notifies the collaborator of the decision. | 🏢 Founder / 👑 Admin |
| `GET` | `/api/founder/applications` | Applications for the founder's own startup — returns `403` if asked for another founder's `startupId`. | 🏢 Founder |
| `GET` | `/api/my/applications` | The user's own applications via `$lookup`-joined opportunity details. Blocks the IDOR where a collaborator queries another user's id. | 🤝 Collaborator / 👑 Admin |
| `DELETE` | `/api/application/:id` | Withdraw an application (applicant, receiving founder, or admin). | 🪪 Owner / 🏢 Founder / 👑 Admin |

### Bookmarks

| Method | Route | Description | Auth |
| --- | --- | --- | --- |
| `POST` | `/api/bookmark` | Save an opportunity. Idempotent — returns the existing bookmark if already saved; owner stamped server-side. | 🪪 Token |
| `DELETE` | `/api/bookmark/:id` | Remove a bookmark. Lookup is scoped to the current user so one user can never delete another's bookmark of the same opportunity. | 🪪 Owner / 👑 Admin |
| `GET` | `/api/my/bookmarks` | The user's saved opportunities, newest first. Blocks cross-user reads. | 🤝 Collaborator / 👑 Admin |

### Users

| Method | Route | Description | Auth |
| --- | --- | --- | --- |
| `GET` | `/api/user/profile/:id` | Read a profile — self or admin only. **Sensitive fields are stripped** (passwords, tokens). | 🪪 Self / 👑 Admin |
| `PATCH` | `/api/user/profile/:id` | Update own profile — a **whitelist** of fields (`name`, `image`, `skills`, `bio`). | 🪪 Self / 👑 Admin |
| `PATCH` | `/api/user/:id` | Block / activate a user account (`status`). | 👑 Admin |
| `GET` | `/api/users` | All users, sanitized, newest first (admin console). | 👑 Admin |

### Notifications

| Method | Route | Description | Auth |
| --- | --- | --- | --- |
| `GET` | `/api/notifications` | The user's notifications (newest 30) plus `unreadCount`. Admins also receive admin-wide alerts. | 🪪 Token |
| `PATCH` | `/api/notifications/mark-all-read` | Mark all of the user's notifications read. | 🪪 Token |
| `PATCH` | `/api/notifications/:id/read` | Mark a single notification read — own notifications only. | 🪪 Token |

---

## 🔐 Authentication & Security

There are **no login/signup routes in this API** — that is deliberate. The companion Next.js client (better-auth) creates sessions and writes them into the shared `session` collection; this server **verifies** them.

- **Bearer token verification** — `verifyToken` reads `Authorization: Bearer <token>`, resolves it against the `session` collection, and loads the user. No token → `401`.
- **Role guards** — `requireAnyRole("founder", "collaborator", …)` returns `403` for the wrong role. It is built to be *invoked* with a role list (`requireAnyRole("founder", "admin")`) rather than chained with `||` — a chained `verifyA || verifyB` would silently skip every check after the first, which previously left routes open.
- **Ownership checks on every mutation** — the founder who owns a startup/opportunity, the applicant or receiving founder for an application, the bookmark owner, and profile self-reads are all asserted in the handler, not left to the client.
- **Server-side identity stamping** — `startupId`, `collaboratorId`, applicant name/email, and plan updates come from the authenticated session, so a client can't spoof ownership.
- **IDOR protection** — cross-user lookups (`/api/my/applications`, `/api/my/bookmarks`, notifications, profiles) are explicitly rejected with `403` when the requested id doesn't match the caller.
- **Sensitive-field sanitization** — a hard-coded blocklist (`password`, `hashedPassword`, `passwordHash`, `token`, `sessionToken`, …) is stripped from every user document before it leaves the server.
- **CORS** — `credentials: true` with the origin pinned to `CLIENT_URL` from env, not `*`.
- **Input validation** — every `:id` route validates `ObjectId` before touching the database; mutation bodies only accept defined fields.

---

## 🗄️ Database

MongoDB via the **native driver** — no ODM, no schema layer. The connection is configured with the **Stable API v1** (`strict: true`, `deprecationErrors: true`) so the driver refuses API-breaking calls at runtime.

**Collections** (created and read directly by this API):

| Collection | Purpose |
| --- | --- |
| `user` | User accounts (name, image, bio, skills, `accountType`, `plan`, `status`) |
| `session` | Auth sessions written by better-auth — the source of truth for token verification |
| `startups` | Founder-submitted startup profiles (status workflow: Pending → Approved / Rejected → Resubmitted) |
| `opportunities` | Open roles posted by founders, with role title, skills, work type, deadline |
| `applications` | Collaborator applications, tracked through Pending / Accepted / Rejected |
| `bookmarks` | Saved opportunities, keyed by `opportunityId` + `userId` |
| `subscriptions` | Stripe payment receipts (plan, amount in cents, `session_id`, payment status) |
| `plans` | Plan definitions driving quota limits (Free / Premium / Enterprise) |
| `notifications` | Per-user and admin-wide alerts with `isRead` flags |

Notable query work: regex-powered search and multi-filter matching, count-then-skip pagination, a `$lookup` aggregation joining applications to opportunities (with string→`ObjectId` coercion), and batched `$in` enrichment for founder profiles.

---

## 🚀 Getting Started

```bash
# 1. Clone
git clone https://github.com/takebul/startup-forge-server.git
cd startup-forge-server

# 2. Install dependencies
npm install

# 3. Configure environment — copy the values below into a `.env` file

# 4. Run
npm start
```

`npm start` runs `node index.js`, which starts Express on `PORT` (default **5000**). Verify with `curl http://localhost:5000/` — it should return `StartupForge server is running fine!`.

> ⚠️ `npm test` is currently a stub (it echoes "no test specified"). This is a known gap, not a feature.

---

## 🔧 Environment Variables

Create a `.env` at the project root. All values are read from `process.env` in [`index.js`](index.js).

| Variable | Default | Description |
| --- | --- | --- |
| `MONGODB_URI` | *(required)* | MongoDB connection string, e.g. `mongodb+srv://<user>:<password>@cluster0.mongodb.net/` |
| `DB_NAME` | *(required)* | Database name holding the collections above |
| `CLIENT_URL` | *(required)* | The frontend origin allowed by CORS, e.g. `http://localhost:3000` |
| `PORT` | `5000` | HTTP port for local development (ignored on Vercel) |

> **Never commit `.env`** — it's gitignored. Vercel reads the same variables from its project dashboard.

---

## 📁 Project Structure

```
startup-forge-server/
├─ index.js          # The entire API — Express setup, middleware, and all 33 routes
├─ vercel.json       # Vercel serverless build (@vercel/node) + catch-all route config
├─ package.json      # Dependencies (express, mongodb, cors, dotenv); ISC license
├─ package-lock.json # Locked dependency versions
├─ .env              # Local environment config (gitignored — never commit)
└─ .gitignore
```

Deliberately compact: no `routes/`, `controllers/`, or `models/` folders — the service's surface is small enough that a single, clearly-sectioned file keeps every route in view.

---

## 🌐 Deployment

Deployed to **Vercel** at **[https://startup-forge-server-nine.vercel.app/](https://startup-forge-server-nine.vercel.app/)**.

[`vercel.json`](vercel.json) builds `index.js` with the `@vercel/node` runtime and routes **all paths and all HTTP methods** (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`) to it as a single serverless function:

```json
{
  "version": 2,
  "builds": [{ "src": "index.js", "use": "@vercel/node" }],
  "routes": [
    { "src": "/(.*)", "dest": "index.js", "methods": ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }
  ]
}
```

The API boots with an explicit DNS override (`1.1.1.1` / `1.0.0.1`) to keep MongoDB Atlas name resolution reliable inside the Vercel serverless runtime.

---

## 🧑‍💻 Author

**Takebul Islam** — full-stack developer building products that pair clean UX with real business logic.

- 🌐 Portfolio: [takebulislam.vercel.app](https://takebulislam.vercel.app/)
- 💼 LinkedIn: [takebulislam](https://www.linkedin.com/in/takebulislam)
- 🐙 GitHub: [@takebul](https://github.com/takebul)

---

## 📄 License

Distributed under the **ISC License** — see [package.json](./package.json).
