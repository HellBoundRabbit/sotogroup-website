# CloudKit Routes System - Multi-Job Design

## 🚛 **Updated CloudKit Record Structure**

### Record Type: `SOTOWebsiteROUTESRoutes` (Updated)

| Field Name | Field Type | Indexed | Description |
|------------|------------|---------|-------------|
| `routeIdString` | STRING | Queryable | Unique route identifier |
| `userIdString` | STRING | Queryable | User who created the route |
| `routeNameString` | STRING | None | Human-readable route name |
| `driverNameString` | STRING | None | Driver assigned to route |
| `driverLocationString` | STRING | None | Driver's location/postcode |
| `totalJobsInt64` | INT64 | None | Total number of jobs in this route |
| `totalDistanceDouble` | DOUBLE | None | Total route distance in miles |
| `estimatedDurationInt64` | INT64 | None | Estimated duration in minutes |
| `statusString` | STRING | None | Route status (active/completed/cancelled) |
| `createdAtTimestamp` | TIMESTAMP | None | When route was created |
| `updatedAtTimestamp` | TIMESTAMP | None | Last update time |

### Record Type: `SOTOWebsiteROUTESJobs` (New)

| Field Name | Field Type | Indexed | Description |
|------------|------------|---------|-------------|
| `jobIdString` | STRING | Queryable | Unique job identifier |
| `routeIdString` | STRING | Queryable | Parent route ID |
| `jobNumberInt64` | INT64 | None | Job sequence number (1, 2, 3...) |
| `collectionAddressString` | STRING | None | Collection address for this job |
| `deliveryAddressString` | STRING | None | Delivery address for this job |
| `collectionPostcodeString` | STRING | None | Collection postcode |
| `deliveryPostcodeString` | STRING | None | Delivery postcode |
| `jobPriceDouble` | DOUBLE | None | Price for this individual job |
| `jobDistanceDouble` | DOUBLE | None | Distance for this job segment |
| `jobDurationInt64` | INT64 | None | Duration for this job segment |
| `jobNotesString` | STRING | None | Notes for this specific job |
| `isCompletedBoolean` | BOOLEAN | None | Whether this job is completed |
| `createdAtTimestamp` | TIMESTAMP | None | When job was created |

## 🔄 **Data Structure Example**

```json
// Route Record
{
  "routeIdString": "route_20240115_001",
  "userIdString": "user_123",
  "routeNameString": "Morning Delivery Run",
  "driverNameString": "John Smith",
  "driverLocationString": "B775JA, Birmingham",
  "totalJobsInt64": 3,
  "totalDistanceDouble": 45.5,
  "estimatedDurationInt64": 180,
  "statusString": "active"
}

// Job Records (3 jobs for this route)
[
  {
    "jobIdString": "job_20240115_001_1",
    "routeIdString": "route_20240115_001",
    "jobNumberInt64": 1,
    "collectionAddressString": "B797RU, Tamworth, Staffordshire",
    "deliveryAddressString": "M1 4AN, Manchester City Centre",
    "collectionPostcodeString": "B797RU",
    "deliveryPostcodeString": "M1 4AN",
    "jobPriceDouble": 150.0,
    "jobDistanceDouble": 25.5,
    "jobDurationInt64": 60,
    "isCompletedBoolean": false
  },
  {
    "jobIdString": "job_20240115_001_2",
    "routeIdString": "route_20240115_001",
    "jobNumberInt64": 2,
    "collectionAddressString": "B775JA, Birmingham",
    "deliveryAddressString": "LS1 4DY, Leeds",
    "collectionPostcodeString": "B775JA",
    "deliveryPostcodeString": "LS1 4DY",
    "jobPriceDouble": 200.0,
    "jobDistanceDouble": 20.0,
    "jobDurationInt64": 120,
    "isCompletedBoolean": false
  }
  // ... more jobs
]
```

## 🎯 **Benefits of This Design**

- ✅ **Multiple jobs per route** - Each route can have unlimited jobs
- ✅ **Individual job tracking** - Track completion status per job
- ✅ **Flexible pricing** - Different prices per job
- ✅ **Route optimization** - Calculate total distance/duration
- ✅ **Job sequencing** - Jobs have sequence numbers
- ✅ **Scalable** - Add/remove jobs without affecting route structure
- ✅ **Detailed analytics** - Track performance per job and per route

## 🔧 **Updated Implementation**

This design allows for:
- **Route-level data**: Driver, total distance, status
- **Job-level data**: Individual collection/delivery addresses, prices, completion status
- **Relationship**: Jobs belong to routes via `routeIdString`
- **Flexibility**: Easy to add/remove jobs, recalculate totals

Would you like me to update the implementation to use this multi-job structure?
