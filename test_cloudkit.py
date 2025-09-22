import requests
import json

# CloudKit configuration
CLOUDKIT_TOKEN = '2810d9a632d5a382d97dfa47fbad426ac6af8a94729cdaaa55aaa8fcc0476560'
CONTAINER_ID = 'icloud.com.soto.SOTO'
BASE_URL = f'https://api.apple-cloudkit.com/database/1/{CONTAINER_ID}/public'

print(f"Testing new API token: {CLOUDKIT_TOKEN[:10]}...")
print(f"Container ID: {CONTAINER_ID}")
print(f"Base URL: {BASE_URL}")

headers = {
    'Content-Type': 'application/json',
    'X-CloudKit-Protocol-Version': '1',
    'Authorization': f'Bearer {CLOUDKIT_TOKEN}'
}

# Test a simple query
query = {
    "recordType": "SOTOGroupWebsite",
    "resultsLimit": 1
}

print(f"\nQuery: {json.dumps(query, indent=2)}")

try:
    response = requests.post(f'{BASE_URL}/records/query', headers=headers, json=query)
    print(f"Response status: {response.status_code}")
    print(f"Response body: {response.text}")
    
    if response.status_code == 200:
        data = response.json()
        if data.get('records'):
            print("✅ SUCCESS! Found records in CloudKit database!")
            for record in data['records']:
                print(f"Client Code: {record['fields']['clientCode']['value']}")
                print(f"Company Name: {record['fields'].get('companyName', {}).get('value', 'Unknown')}")
                print(f"Pricing Formula: {record['fields']['pricingFormula']['value']}")
        else:
            print("❌ No records found")
    else:
        print(f"❌ Request failed with status {response.status_code}")
        
except Exception as e:
    print(f"❌ Error: {e}") 