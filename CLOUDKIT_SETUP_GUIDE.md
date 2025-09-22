# CloudKit Routes System - Complete Setup Guide

## 🗂️ Required CloudKit Record Types

You need to create **TWO** record types in your CloudKit dashboard with the exact field names, types, and indexes specified below.

---

## 📋 Record Type 1: `SOTOWebsiteROUTESRoutes`

### Fields Configuration:

| Field Name | Field Type | Indexed | Index Type | Description |
|------------|------------|---------|------------|-------------|
| `routeIdString` | STRING | ✅ **YES** | **Queryable** | Unique route identifier |
| `userIdString` | STRING | ✅ **YES** | **Queryable** | User who created the route |
| `routeNameString` | STRING | ❌ No | None | Route name (always the registration of first job delivery) |
| `driverNameString` | STRING | ❌ No | None | Driver assigned to route |
| `driverLocationString` | STRING | ❌ No | None | Driver's location/postcode |
| `totalJobsInt64` | INT64 | ❌ No | None | Total number of jobs in this route |
| `totalDistanceDouble` | DOUBLE | ❌ No | None | Total route distance in miles |
| `estimatedDurationInt64` | INT64 | ❌ No | None | Estimated duration in minutes |
| `statusString` | STRING | ❌ No | None | Route status (active/completed/cancelled) |
| `createdAtTimestamp` | TIMESTAMP | ❌ No | None | When route was created (ENCRYPTED) |
| `updatedAtTimestamp` | TIMESTAMP | ❌ No | None | Last update time (ENCRYPTED) |

---

## 📋 Record Type 2: `SOTOWebsiteROUTESJobs`

### Fields Configuration:

| Field Name | Field Type | Indexed | Index Type | Description |
|------------|------------|---------|------------|-------------|
| `jobIdString` | STRING | ✅ **YES** | **Queryable** | Unique job identifier |
| `routeIdString` | STRING | ✅ **YES** | **Queryable** | Parent route ID |
| `jobNumberInt64` | INT64 | ❌ No | None | Job sequence number (1, 2, 3...) |
| `collectionAddressString` | STRING | ❌ No | None | Collection address for this job |
| `deliveryAddressString` | STRING | ❌ No | None | Delivery address for this job |
| `collectionPostcodeString` | STRING | ❌ No | None | Collection postcode |
| `deliveryPostcodeString` | STRING | ❌ No | None | Delivery postcode |
| `jobPriceDouble` | DOUBLE | ❌ No | None | Price for this individual job |
| `jobDistanceDouble` | DOUBLE | ❌ No | None | Distance for this job segment |
| `jobDurationInt64` | INT64 | ❌ No | None | Duration for this job segment |
| `jobNotesString` | STRING | ❌ No | None | Notes for this specific job |
| `isCompletedInt64` | INT64 | ❌ No | None | Whether this job is completed (0=false, 1=true) |
| `createdAtTimestamp` | TIMESTAMP | ❌ No | None | When job was created (ENCRYPTED) |

---

## 🔧 Step-by-Step Setup Instructions

### Step 1: Access CloudKit Dashboard
1. Go to [CloudKit Dashboard](https://icloud.developer.apple.com/dashboard/)
2. Sign in with your Apple Developer account
3. Select your SOTO project/container
4. Make sure you're in the **Development** environment

### Step 2: Create Record Type 1 - Routes

1. **Navigate to Record Types**
   - Click on "Record Types" in the left sidebar

2. **Create New Record Type**
   - Click the **"+"** button next to "Record Types"
   - Enter name: `SOTOWebsiteROUTESRoutes`
   - Click "Save"

3. **Add Fields** (Add each field in this exact order):
   
   **Field 1: routeIdString**
   - Click "Add Field"
   - Name: `routeIdString`
   - Type: **STRING**
   - Indexed: ✅ **YES**
   - Index Type: **Queryable**
   - Click "Save"

   **Field 2: userIdString**
   - Click "Add Field"
   - Name: `userIdString`
   - Type: **STRING**
   - Indexed: ✅ **YES**
   - Index Type: **Queryable**
   - Click "Save"

   **Field 3: routeNameString**
   - Click "Add Field"
   - Name: `routeNameString`
   - Type: **STRING**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 4: driverNameString**
   - Click "Add Field"
   - Name: `driverNameString`
   - Type: **STRING**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 5: driverLocationString**
   - Click "Add Field"
   - Name: `driverLocationString`
   - Type: **STRING**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 6: totalJobsInt64**
   - Click "Add Field"
   - Name: `totalJobsInt64`
   - Type: **INT64**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 7: totalDistanceDouble**
   - Click "Add Field"
   - Name: `totalDistanceDouble`
   - Type: **DOUBLE**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 8: estimatedDurationInt64**
   - Click "Add Field"
   - Name: `estimatedDurationInt64`
   - Type: **INT64**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 9: statusString**
   - Click "Add Field"
   - Name: `statusString`
   - Type: **STRING**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 10: createdAtTimestamp**
   - Click "Add Field"
   - Name: `createdAtTimestamp`
   - Type: **TIMESTAMP**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 11: updatedAtTimestamp**
   - Click "Add Field"
   - Name: `updatedAtTimestamp`
   - Type: **TIMESTAMP**
   - Indexed: ❌ **No**
   - Click "Save"

4. **Save Record Type**
   - Click "Save Changes" at the bottom

### Step 3: Create Record Type 2 - Jobs

1. **Create New Record Type**
   - Click the **"+"** button next to "Record Types"
   - Enter name: `SOTOWebsiteROUTESJobs`
   - Click "Save"

2. **Add Fields** (Add each field in this exact order):

   **Field 1: jobIdString**
   - Click "Add Field"
   - Name: `jobIdString`
   - Type: **STRING**
   - Indexed: ✅ **YES**
   - Index Type: **Queryable**
   - Click "Save"

   **Field 2: routeIdString**
   - Click "Add Field"
   - Name: `routeIdString`
   - Type: **STRING**
   - Indexed: ✅ **YES**
   - Index Type: **Queryable**
   - Click "Save"

   **Field 3: jobNumberInt64**
   - Click "Add Field"
   - Name: `jobNumberInt64`
   - Type: **INT64**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 4: collectionAddressString**
   - Click "Add Field"
   - Name: `collectionAddressString`
   - Type: **STRING**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 5: deliveryAddressString**
   - Click "Add Field"
   - Name: `deliveryAddressString`
   - Type: **STRING**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 6: collectionPostcodeString**
   - Click "Add Field"
   - Name: `collectionPostcodeString`
   - Type: **STRING**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 7: deliveryPostcodeString**
   - Click "Add Field"
   - Name: `deliveryPostcodeString`
   - Type: **STRING**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 8: jobPriceDouble**
   - Click "Add Field"
   - Name: `jobPriceDouble`
   - Type: **DOUBLE**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 9: jobDistanceDouble**
   - Click "Add Field"
   - Name: `jobDistanceDouble`
   - Type: **DOUBLE**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 10: jobDurationInt64**
   - Click "Add Field"
   - Name: `jobDurationInt64`
   - Type: **INT64**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 11: jobNotesString**
   - Click "Add Field"
   - Name: `jobNotesString`
   - Type: **STRING**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 12: isCompletedInt64**
   - Click "Add Field"
   - Name: `isCompletedInt64`
   - Type: **INT64**
   - Indexed: ❌ **No**
   - Click "Save"

   **Field 13: createdAtTimestamp**
   - Click "Add Field"
   - Name: `createdAtTimestamp`
   - Type: **TIMESTAMP**
   - Indexed: ❌ **No**
   - Click "Save"

3. **Save Record Type**
   - Click "Save Changes" at the bottom

---

## ✅ Verification Checklist

After creating both record types, verify:

- [ ] `SOTOWebsiteROUTESRoutes` record type exists with 11 fields
- [ ] `SOTOWebsiteROUTESJobs` record type exists with 13 fields
- [ ] `routeIdString` is Queryable in Routes record type
- [ ] `userIdString` is Queryable in Routes record type
- [ ] `jobIdString` is Queryable in Jobs record type
- [ ] `routeIdString` is Queryable in Jobs record type
- [ ] All other fields are NOT indexed
- [ ] Both record types are saved successfully

---

## 🧪 Testing After Setup

1. **Start your server**: `python3 server.py`
2. **Visit routes page**: `http://localhost:8000/pages/routes.html`
3. **Click "Optimise"** to create test routes
4. **Check CloudKit Dashboard** to see the records being created
5. **Verify the relationship** between routes and jobs via `routeIdString`

---

## 🔗 Important Notes

- **Field names must match exactly** as specified (case-sensitive)
- **Indexes are crucial** for querying performance
- **Only Queryable indexes** are needed for this implementation
- **Development environment** is used for testing
- **Production deployment** will require schema deployment

The system is now ready to handle multiple jobs per route with full CloudKit persistence!
