Library Management System

Course: SOFE 4790U — Distributed Systems (Ontario Tech University)

1. Overview

This project implements a distributed, multi-branch public library management system modeled after a regional library network spanning Ajax, Oshawa, and Whitby. Instead of relying on a single centralized database that creates a single point of failure, each library branch operates as an autonomous node backed by its own isolated MongoDB cluster.

Patrons interact with the network through a unified web interface and API gateway. When a patron searches for a physical book that is out of stock at their Home Branch, their home server dynamically queries peer branches in parallel, reports availability even if a peer branch is offline, and orchestrates a fault-tolerant Inter-Library Transfer Saga to bring the item to their home branch.

2. System Architecture

+------------------------------------------------------------------------------+
|                         CLIENT (React MVC Web App)                           |
+--------------------------------------+---------------------------------------+
                                       | HTTP/REST + JWT { homeBranch }
                                       v
+==============================================================================+
|                    NGINX API Gateway / L7 Load Balancer                      |
|         * Routes external traffic to Home Branch                             |
|         * Blocks public access to /internal/* peer-only endpoints            |
+----------+---------------------------+---------------------------+-----------+
           |                           |                           |
           v                           v                           v
+---------------------+     +---------------------+     +---------------------+
|   branch-ajax       |     |   branch-oshawa     |     |   branch-whitby     |
|   (Express MVC)     |<--->|   (Express MVC)     |<--->|   (Express MVC)     |
+----------+----------+     +----------+----------+     +----------+----------+
           |        Peer HTTP Mesh (/internal/* + X-Lamport-Clock) |
           v                           v                           v
+---------------------+     +---------------------+     +---------------------+
|   mongo-ajax        |     |   mongo-oshawa      |     |   mongo-whitby      |
|   (DB Cluster 1)    |     |   (DB Cluster 2)    |     |   (DB Cluster 3)    |
+---------------------+     +---------------------+     +---------------------+


Core Architectural Principles

Unified Codebase, Environment-Driven Identity: All three branch servers run the exact same server/ Express codebase, configured at runtime via BRANCH_ID, PORT, MONGO_URI, and PEER_URLS.

Strict Database Isolation: Each branch connects exclusively to its own MongoDB instance. Branches never query another branch's database directly; all cross-branch operations traverse HTTP /internal/* endpoints.

Stateless Application Tier: Authentication uses stateless JSON Web Tokens (JWT) containing { userId, role, homeBranch }, allowing horizontal scaling of any branch behind NGINX or Kubernetes load balancers.

3. Distributed Systems Features

Concept

Implementation Details

Federated Discovery & Fault Tolerance

Local-first catalog search. On a local miss (availableCopies === 0 for physical items), the Home Branch fans out parallel GET /internal/ping-search requests using Promise.allSettled() with an 800ms timeout. If one branch is offline, search degrades gracefully and surfaces available peers alongside an offline-branch warning.

Inter-Library Transfer Saga

Multi-step cross-cluster workflow using an idempotent TransferLog (transferId), time-limited lockLease on Book documents, and atomic conditional $inc updates. If the destination commit fails, a compensating transaction rolls back the source inventory automatically.

Concurrency Control

Prevents double-borrowing the last copy under simultaneous requests using atomic MongoDB filters (availableCopies: { $gt: 0 }) and expiring lease locks (lockLease.expiresAt).

Lamport Logical Clocks & Custody Tracking

Every peer HTTP request propagates an X-Lamport-Clock header updated via $C_{\text{local}} = \max(C_{\text{local}}, C_{\text{incoming}}) + 1$. Loan documents record an ordered custodyHistory log so returned physical books automatically route back to their originBranch.

Physical vs. Digital Media

Physical titles are bound to branch copy counts and require inter-branch transfers; digital titles support instant remote borrowing without inventory transfers.

Replication & High Availability

Supports MongoDB Replica Sets (with WiredTiger cache capped at 0.25 GB per node for local development) and GET /healthz readiness probes for zero-downtime failover.

4. Repository Structure

Final_Project/
├── .gitignore                  # Root ignore rules (node_modules, .env, DB volumes, K8s configs)
├── CLAUDE.md                   # Architectural rules & AI assistant guidelines
├── README.md                   # Project documentation
├── docker-compose.yml          # Orchestrates NGINX gateway, 3 branch servers, & 3 MongoDB clusters
├── gateway/
│   └── nginx.conf              # L7 load balancing, routing, & /internal/* firewall rules
├── client/                     # React frontend application
├── k8s/                        # Optional Kubernetes manifests (Kind / local K8s testing)
└── server/                     # Unified Express MVC backend (runs as ajax, oshawa, whitby)
    ├── Dockerfile
    ├── .dockerignore
    ├── .env.example
    ├── package.json
    ├── src/
    │   ├── config/             # Environment validation, branch constants, & Mongoose connection
    │   ├── models/             # Mongoose schemas (User, Book, Loan, TransferLog)
    │   ├── controllers/        # Thin HTTP handlers (auth, catalog, circulation, internal, health)
    │   ├── services/           # Distributed logic (discoveryService, transferSaga, recommendationService)
    │   ├── middlewares/        # JWT auth, Lamport clock sync, request tracing, & error handling
    │   ├── routes/             # Express routers (/api/* and /internal/*)
    │   ├── utils/              # Lamport clock utility & custom AppError class
    │   ├── seeds/              # Branch-aware database seeder
    │   ├── app.js              # Express app configuration
    │   └── server.js           # Process boot, DB init, & SIGTERM graceful shutdown
    └── tests/                  # Concurrency & peer-failover integration tests


5. Getting Started

Prerequisites

Docker & Docker Compose (recommended for running all 3 branches and 3 databases)

Node.js v20+ & npm (for local scripts and testing)

1. Environment Setup

Copy the example environment file inside server/ if running outside Docker:

cp server/.env.example server/.env


2. Run the Full 3-Branch Network with Docker Compose

From the root Final_Project/ directory:

docker compose up --build


This starts:

NGINX Gateway: http://localhost:8080

Branch Servers: branch-ajax, branch-oshawa, branch-whitby (with live hot-reloading on server/src/)

Isolated Databases: mongo-ajax, mongo-oshawa, mongo-whitby

3. Verify Cluster Health

Check the health endpoints for all three branches:

curl http://localhost:8080/healthz


4. Run Concurrency & Failover Tests

cd server
npm test

