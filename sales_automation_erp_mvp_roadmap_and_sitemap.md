# SALES AUTOMATION + ERP MVP
## Product Roadmap & System Sitemap

---

# 1. PROJECT OVERVIEW

## Goal
Build a complete:
- Sales Automation Mobile App (Android APK)
- ERP Admin System (Web App)

For:
- FMCG
- Distribution
- Wholesale
- Field Sales Operations

---

# 2. TECHNOLOGY STACK

| Layer | Technology |
|---|---|
| Mobile App | Flutter |
| ERP Web | React + Vite |
| Backend | Firebase |
| Database | Firestore |
| Authentication | Firebase Auth |
| File Storage | Firebase Storage |
| Functions | Cloud Functions |
| Notifications | Firebase Cloud Messaging |
| Analytics | BigQuery (Future) |
| Maps | Google Maps API |
| Face Recognition | ML Kit |

---

# 3. SYSTEM ARCHITECTURE

## Mobile App
- Offline-first architecture
- Local cache
- Background sync
- GPS tracking
- Real-time updates

## ERP Web
- Role-based dashboard
- Analytics
- Reports
- Master management
- Approval workflow

## Backend
- Firestore collections
- Cloud Functions
- Event-driven operations
- Notification engine

---

# 4. USER ROLES

## Admin
- Full access

## General Manager
- Global reports
- KPI monitoring

## ASM / Supervisor
- Team monitoring
- Approvals
- Route management

## Sales Representative
- Attendance
- Orders
- Collections
- Visits

## Distributor
- Order monitoring
- Inventory visibility

## Merchandiser
- Merchandising
- Outlet Visit

## Delivery Boy
- Delivery tracking
- Proof of delivery

---

# 5. MOBILE APP SITEMAP

# LOGIN
- Splash Screen
- Choose Company / Enter Company Code
- Load Company Configuration
- Login Screen (Company + Username + Password)
- Forgot Password
- Biometric Login (Optional)
- Device Verification

---

# MAIN NAVIGATION

## 1. Dashboard
### Screens
- KPI Summary
- Monthly Overview
- Timeline Activity
- Visit Summary
- LPC Analytics
- Strike Rate Summary

### Widgets
- Total Outlet
- Visited Outlet
- Non Visited Outlet
- Productive Call
- Non Productive Call
- Pending Collection
- Order Summary

---

## 2. Attendance
### Screens
- Check In
- Selfie Capture
- Face Verification
- GPS Validation
- Check Out
- Attendance Logs
- Working Hours Summary

### Features
- Fake GPS detection
- One attendance per day
- Auto checkout

---

## 3. Route
### Screens
- Daily Route
- Route Map
- Route Sequence
- Nearby Outlet
- Route Change Request
- Approved Route

### Features
- Geo-fencing
- Route optimization
- Live navigation

---

## 4. Outlet Visit
### Screens
- Outlet List
- Outlet Details
- Check In
- Check Out
- Visit History
- Retailer Profile

### Features
- GPS validation
- Visit duration
- Outlet classification
- Retailer notes

---

## 5. Order Module
### Screens
- Create Order
- SKU Catalogue
- Product Search
- Cart
- Order Summary
- Draft Orders
- Order History

### Features
- Barcode scan
- Offline order
- Promotion engine
- Outstanding validation
- Credit limit check
- LPC tracking

---

## 6. Collections
### Screens
- Due Invoice List
- Collection Entry
- Payment Mode
- Receipt View
- Collection History

### Features
- Cash collection
- Bank collection
- Cheque entry
- Signature capture
- Receipt generation

---

## 7. Reports
### Screens
- Daily Sales Report
- Monthly Sales Report
- LPC Report
- Strike Rate Report
- Collection Report
- Attendance Report

### Features
- PDF export
- Excel export
- Date filtering

---

## 8. Catalogue
### Screens
- Product Categories
- Product Details
- Promotion Offers
- Price List
- New Products

### Features
- Product image gallery
- SKU search
- Brand filter

---

## 9. Notifications
### Screens
- Alerts
- Approvals
- Announcements
- Reminders

---

## 10. Settings
### Screens
- Profile
- Device Info
- Language
- Sync Status
- Clear Cache
- Logout

---

# 6. ERP WEB SITEMAP

# AUTHENTICATION
- Login
- Password Reset
- 2FA (Optional)
- Session Management

---

# ERP MAIN MENU

## 1. Dashboard
### Sections
- Total Sales
- Active Users
- Live GPS
- Attendance Summary
- Collection Summary
- KPI Charts
- Sales Trend
- Route Efficiency

---

## 2. User Management
### Screens
- User List
- Add User
- Edit User
- Assign Role
- Assign Route
- Device Binding
- Face Registration
- User Activity Log

---

## 3. Outlet Management
### Screens
- Outlet List
- Add Outlet
- Geo Tagging
- Outlet Classification
- Outlet Mapping
- Outlet Analytics

---

## 4. Product Management
### Screens
- SKU List
- Product Categories
- Brand Management
- Price Management
- Promotion Setup
- Stock Visibility

---

## 5. Route Management
### Screens
- Route Planner
- Territory Mapping
- Route Assignment
- Route Optimization
- Route Analytics

---

## 6. Order Management
### Screens
- Pending Orders
- Approved Orders
- Invoice Generation
- Order Timeline
- Order Analytics

### Features
- Approval workflow
- Discount override
- Order cancellation

---

## 7. Collection Management
### Screens
- Outstanding Report
- Collection Entry
- Payment Reconciliation
- Due Aging Report
- Collection Analytics

---

## 8. Attendance Monitoring
### Screens
- Live Attendance
- GPS Tracking
- Attendance Logs
- Working Hours
- Attendance Analytics

---

## 9. Inventory Management (Phase 2)
### Screens
- Warehouse Stock
- Stock Transfer
- Damage Stock
- Expiry Tracking
- Batch Tracking

---

## 10. Delivery Module (Phase 2)
### Screens
- Delivery Queue
- Vehicle Assignment
- Delivery Tracking
- Proof of Delivery

---

## 11. Reports & Analytics
### Screens
- Sales Analytics
- LPC Analytics
- Outlet Productivity
- Salesman Performance
- Heatmap Analytics
- Forecasting

---

## 12. Approval Center
### Screens
- Route Approval
- Discount Approval
- Credit Approval
- Return Approval
- Expense Approval

---

## 13. Notifications Center
### Screens
- Alerts
- Push Notifications
- Broadcast Messages
- Notification History

---

## 14. Settings & Configuration
### Screens
- Company Settings
- Tax Settings
- Role Permissions
- Feature Flags
- Backup & Restore
- Data Retention

---

# 7. FIRESTORE COLLECTION STRUCTURE

# Core Collections

## users
- employee profile
- role
- route
- device info

## outlets
- outlet profile
- GPS
- route
- retailer info

## attendance
- check-in
- check-out
- selfie
- GPS

## visits
- outlet visit logs
- timestamps
- GPS

## orders
- order header
- totals
- status

## order_items
- SKU
- quantity
- pricing

## collections
- payments
- receipts

## routes
- assigned route
- outlet sequence

## products
- SKU master
- pricing
- stock

## notifications
- alerts
- approvals

## dashboard_stats
- pre-aggregated KPI data

---

# 8. API / EVENT ARCHITECTURE

# Core Events
- attendance_submitted
- visit_started
- visit_completed
- order_created
- order_approved
- collection_received
- route_changed
- sync_completed

---

# 9. DEVELOPMENT ROADMAP

# PHASE 1 — FOUNDATION
## Duration
2 Weeks

## Tasks
- Firebase setup
- Firestore schema
- Authentication
- User roles
- App architecture
- ERP boilerplate
- Navigation setup

---

# PHASE 2 — CORE MOBILE MVP
## Duration
4 Weeks

## Features
- Login
- Dashboard
- Attendance
- Route
- Outlet Visit
- Order Module
- Offline sync
- GPS validation

---

# PHASE 3 — ERP MVP
## Duration
3 Weeks

## Features
- ERP Dashboard
- User Management
- Outlet Management
- Product Management
- Route Management
- Order Monitoring
- Basic Reports

---

# PHASE 4 — COLLECTIONS & REPORTS
## Duration
2 Weeks

## Features
- Collections
- Receipt generation
- KPI reports
- PDF export
- Excel export

---

# PHASE 5 — ADVANCED OPERATIONS
## Duration
3 Weeks

## Features
- Face recognition
- Live GPS tracking
- Notifications
- Approval workflow
- Promotion engine
- Expense module

---

# PHASE 6 — INVENTORY & DELIVERY
## Duration
4 Weeks

## Features
- Inventory module
- Batch tracking
- Delivery tracking
- Van sales
- Warehouse operations

---

# PHASE 7 — ANALYTICS & AI
## Duration
Ongoing

## Features
- Forecasting
- AI recommendations
- Heatmaps
- Predictive analytics
- Retailer intelligence

---

# 10. PERFORMANCE STRATEGY

## Firestore Optimization
- Small documents
- Pagination
- Composite indexes
- Pre-aggregated dashboard collections
- Offline cache

## Mobile Optimization
- Lazy loading
- Image compression
- Background sync
- Battery optimization

## ERP Optimization
- Server-side aggregation
- Cached analytics
- Role-based queries

---

# 11. SECURITY STRATEGY

## Mobile Security
- Device binding
- Fake GPS detection
- Root detection
- Token validation

## Backend Security
- Firestore rules
- Role-based access
- Audit logs
- API validation

---

# 12. MVP PRIORITY

# MUST HAVE
- Authentication
- Attendance
- Route
- Outlet Visit
- Order
- Dashboard
- Reports
- Collections

---

# SHOULD HAVE
- Live GPS
- Approvals
- Notifications
- Promotions
- Expense claims

---

# FUTURE FEATURES
- AI forecasting
- Distributor portal
- Retailer app
- Voice order
- Marketplace
- Smart recommendations

---

# 13. FINAL RECOMMENDED ARCHITECTURE

## Mobile App
Flutter + Firebase SDK

## ERP
React + Vite

## Backend
Firebase + Cloud Functions

## Database
Firestore

## Future Scaling
- PostgreSQL
- BigQuery
- Elasticsearch

---

# 14. SUCCESS FACTORS

The success of this platform depends on:

1. Fast offline sync
2. Simple UX
3. Stable GPS validation
4. Reliable attendance system
5. Scalable Firestore structure
6. Smart aggregation strategy
7. Clean workflow architecture
8. Good reporting
9. Fast loading performance
10. Strong security model

---

# 15. MULTI-COMPANY SAAS ARCHITECTURE

## Goal
Sell the platform to multiple companies using a single centralized platform.

This means:
- each company has isolated data
- separate branding
- separate users
- separate subscriptions
- separate permissions

This architecture is called:

# Multi-Tenant SaaS

---

# SAAS MODEL TYPES

## OPTION 1 — Single Database Multi-Tenant (Recommended MVP)

All companies share:
- same Firebase project
- same Firestore database
- same backend

But every document contains:

```json
{
  "tenantId": "company_001"
}
```

Example:

```text
orders
  tenantId = companyA

users
  tenantId = companyA
```

## Advantages
- cheapest
- fastest
- easiest to maintain
- scalable for MVP

## Recommended For
- first 50–100 companies

---

## OPTION 2 — Separate Database Per Company

Each company gets:
- separate Firebase project
- separate database

## Advantages
- stronger isolation
- enterprise clients prefer this

## Disadvantages
- harder maintenance
- higher cost
- more DevOps work

## Recommended For
- enterprise clients
- very large customers

---

# RECOMMENDED SAAS ARCHITECTURE

# PHASE 1
Use:
- single Firebase project
- tenantId-based isolation

# PHASE 2
Add:
- enterprise isolated deployments

---

# REQUIRED MULTI-TENANT DATABASE DESIGN

Every important collection MUST contain:

```json
{
  "tenantId": "tenant_001"
}
```

## Required Collections
- users
- outlets
- attendance
- visits
- orders
- collections
- routes
- products
- reports
- notifications

---

# FIRESTORE SECURITY RULES

Critical requirement.

Users MUST only access their tenant data.

Example logic:

```text
request.auth.token.tenantId == resource.data.tenantId
```

This is extremely important.

---

# SAAS SUPER ADMIN PANEL

You need an additional panel for yourself.

# Super Admin Features

## Company Management
- create company
- suspend company
- activate company
- delete company

## Subscription Management
- package control
- payment tracking
- renewal reminders
- feature access

## Usage Monitoring
- total users
- total orders
- storage usage
- API usage

## White Label Control
- company logo
- company colors
- app name
- domain mapping

## Audit & Security
- audit logs
- tenant activity

---

# COMPANY ONBOARDING FLOW

## Step 1
Create company

## Step 2
Generate tenantId

## Step 3
Create admin account

## Step 4
Assign subscription

## Step 5
Initialize default settings

---

# SAAS SUBSCRIPTION PLANS

## BASIC
- small team
- limited users
- basic reports

## PROFESSIONAL
- advanced analytics
- collections
- GPS tracking
- approvals

## ENTERPRISE
- AI features
- dedicated database
- advanced integrations
- custom branding

---

# FEATURE FLAG SYSTEM

Enable/disable modules per company.

Example:

```text
companyA
  collections = true
  inventory = false

companyB
  collections = true
  inventory = true
```

Very important for SaaS.

---

# WHITE LABEL SUPPORT

Allow:
- company logo
- splash screen
- app colors
- custom APK
- company name

This increases commercial value greatly.

---

# CUSTOM DOMAIN SUPPORT

Example:

```text
companyA.yourplatform.com
companyB.yourplatform.com
```

Future enterprise feature.

---

# BILLING & PAYMENT MODULE

Track:
- subscription status
- invoices
- payment history
- renewals
- trial periods

---

# MULTI-TENANT PERFORMANCE STRATEGY

## Important Rules

### NEVER query without tenantId

BAD:

```text
orders collection full scan
```

GOOD:

```text
WHERE tenantId == currentTenant
```

---

# INDEX STRATEGY

Create composite indexes using:
- tenantId
- createdAt
- userId
- routeId

This keeps SaaS performance fast.

---

# MULTI-TENANT ANALYTICS

Track per company:
- sales volume
- active users
- sync health
- attendance quality
- storage usage

---

# FUTURE SAAS SCALING

## Future Architecture

| Purpose | Technology |
|---|---|
| Mobile Live Data | Firestore |
| ERP Analytics | PostgreSQL |
| BI & Forecasting | BigQuery |
| Search | Elasticsearch |
| Media Storage | Firebase Storage |

---

# RECOMMENDED COMMERCIAL MODEL

## One-Time License
OR
## Monthly Subscription (Recommended)

Example:
- per user pricing
- per company pricing
- feature-based pricing

SaaS subscription is much more scalable.

---

# MOST IMPORTANT SAAS REQUIREMENTS

1. Strong tenant isolation
2. Feature flag system
3. Scalable Firestore indexes
4. Billing system
5. White-label support
6. Super admin panel
7. Audit logs
8. Usage tracking
9. Fast onboarding
10. Secure Firestore rules

---

# FINAL SAAS RECOMMENDATION

For your platform:

## BEST STARTING ARCHITECTURE

### Frontend
- Flutter Mobile App
- React ERP Web

### Backend
- Firebase + Cloud Functions

### Database
- Firestore

### SaaS Model
- Single database multi-tenant
- tenantId isolation

### Scaling Later
- PostgreSQL
- BigQuery
- Elasticsearch

This is the best balance between:
- speed
- cost
- scalability
- maintainability
- MVP launch speed

