from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import json
import os
from soto_lp_database import SOTOLPDatabase
from soto_lp_ai import SOTOLPAI

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# CloudKit Server-to-Server configuration
import os
import time
import hashlib
import base64
from datetime import datetime
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend

# Your CloudKit credentials
PRIVATE_KEY = '''-----BEGIN EC PRIVATE KEY-----
MHcCAQEEICMnFBBDt7whEuN5jyxAWRBKWk5f92MW/VosrjuJC7a7oAoGCCqGSM49
AwEHoUQDQgAEzLPo+4qbB09wRN+EyZuWmSwqNCWqZAqgFKpaWJwAfAeT9EaMvZv3
DyJKiQdOdOad5aJHbR69CPgx/C41hyDg/g==
-----END EC PRIVATE KEY-----'''

KEY_ID = 'c1359a7612f196af40ecb771705cfb8c91a4513a8660dff53f51725ffd6e140f'
ISSUER_ID = '6U267VMJ62'  # Apple Developer Team ID
CONTAINER_ID = 'icloud.com.soto.SOTO'
BASE_URL = f'https://api.apple-cloudkit.com/database/1/{CONTAINER_ID}/public'
CLOUDKIT_TOKEN = '712aded6feaa40243f5ba7da1232737bbf3e01b9a487797ee7e24286498037f8'

# SOTO-LP Configuration
GOOGLE_AI_API_KEY = os.getenv('GOOGLE_AI_API_KEY', 'AIzaSyB4uvwU4HZ1Ot9TF4AV7-JxcLzmub7NBgg')
GOOGLE_MAPS_API_KEY = os.getenv('GOOGLE_MAPS_API_KEY', 'AIzaSyDTbiSXo9tg1Tx8SlZCZKsR_R0zIQ4N1VA')

# Initialize SOTO-LP components
db = SOTOLPDatabase()

# Initialize AI processor (will be created dynamically in API calls)
ai_processor = None

def create_signed_request(query, operation='query'):
    """Create a signed request for CloudKit Server-to-Server authentication"""
    # Get current date in ISO8601 format
    current_date = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    
    # Create the request body (base64 encoded SHA-256 hash)
    request_body = json.dumps(query)
    body_hash = hashlib.sha256(request_body.encode()).digest()
    body_hash_b64 = base64.b64encode(body_hash).decode()
    
    # Create the web service URL subpath based on operation
    if operation == 'modify':
        url_subpath = f'/database/1/{CONTAINER_ID}/public/records/modify'
    else:
        url_subpath = f'/database/1/{CONTAINER_ID}/public/records/query'
    
    # Concatenate the parameters with colons
    message = f"{current_date}:{body_hash_b64}:{url_subpath}"
    
    # Load the private key and create ECDSA signature
    private_key = serialization.load_pem_private_key(
        PRIVATE_KEY.encode(),
        password=None,
        backend=default_backend()
    )
    
    # Sign the message with ECDSA
    signature = private_key.sign(
        message.encode(),
        ec.ECDSA(hashes.SHA256())
    )
    
    # Create the full URL
    url = f'https://api.apple-cloudkit.com{url_subpath}'
    
    # Prepare headers
    headers = {
        'Content-Type': 'application/json',
        'X-Apple-CloudKit-Request-KeyID': KEY_ID,
        'X-Apple-CloudKit-Request-ISO8601Date': current_date,
        'X-Apple-CloudKit-Request-SignatureV1': base64.b64encode(signature).decode(),
        'X-Apple-CloudKit-Request-IssuerID': ISSUER_ID
    }
    
    # Make the HTTP request
    response = requests.post(url, headers=headers, data=request_body)
    return response

@app.route('/')
def index():
    return app.send_static_file('index.html')

@app.route('/<path:filename>')
def serve_static(filename):
    return app.send_static_file(filename)

@app.route('/api/validate-client', methods=['POST'])
def validate_client():
    try:
        data = request.get_json()
        client_code = data.get('clientCode')
        
        if not client_code:
            return jsonify({'error': 'Client code is required'}), 400

        # Create the query for CloudKit
        query = {
            "recordType": "SOTOGroupWebsite",
            "filterBy": [
                {
                    "fieldName": "clientCode",
                    "comparator": "EQUALS",
                    "fieldValue": {
                        "value": client_code,
                        "type": "STRING"
                    }
                }
            ]
        }

        # Create the query for CloudKit
        query = {
            "recordType": "SOTOGroupWebsite",
            "filterBy": [
                {
                    "fieldName": "clientCode",
                    "comparator": "EQUALS",
                    "fieldValue": {
                        "value": client_code,
                        "type": "STRING"
                    }
                }
            ]
        }

        # Create signed request
        signed_request = create_signed_request(query)
        current_date = signed_request['headers']['X-Apple-CloudKit-Request-ISO8601Date']
        signature = base64.b64decode(signed_request['headers']['X-Apple-CloudKit-Request-SignatureV1'])
        request_body = signed_request['body']
        
        # Try to make the request to CloudKit using token-based auth first
        try:
            # Try with token-based authentication (like server.js)
            token_headers = {
                    'Content-Type': 'application/json',
                'X-CloudKit-Protocol-Version': '1',
                'Authorization': f'Bearer {CLOUDKIT_TOKEN}'
            }
            
            response = requests.post(
                f'{BASE_URL}/records/query',
                headers=token_headers,
                json=query
            )

            if response.ok:
                data = response.json()
                
                # Check if we found a matching client code
                if data.get('records') and len(data['records']) > 0:
                    record = data['records'][0]
                    return jsonify({
                        'valid': True,
                        'clientCode': record['fields']['clientCode']['value'],
                        'pricingFormula': record['fields']['pricingFormula']['value'],
                        'companyName': record['fields'].get('companyName', {}).get('value', 'Unknown')
                    })
                else:
                    return jsonify({
                        'valid': False,
                        'message': 'Incorrect client code'
                    })
            else:
                print(f'Token-based CloudKit request failed: {response.status_code} {response.text}')
                
                # Try with server-to-server authentication
                response = requests.post(
                    f'{BASE_URL}/records/query',
                    headers=signed_request['headers'],
                    json=query
                )

                if response.ok:
                    data = response.json()
                    
                    # Check if we found a matching client code
                    if data.get('records') and len(data['records']) > 0:
                        record = data['records'][0]
                        return jsonify({
                            'valid': True,
                            'clientCode': record['fields']['clientCode']['value'],
                            'pricingFormula': record['fields']['pricingFormula']['value'],
                            'companyName': record['fields'].get('companyName', {}).get('value', 'Unknown')
                        })
                    else:
                        return jsonify({
                            'valid': False,
                            'message': 'Incorrect client code'
                        })
                else:
                    print(f'Server-to-server CloudKit request failed: {response.status_code} {response.text}')
                    # Fallback to test mode for development
                return jsonify({
                    'valid': True,
                        'clientCode': client_code,
                    'pricingFormula': 'distance*10',
                        'companyName': f'Test Company ({client_code})'
                })
                
        except Exception as e:
            print(f'CloudKit connection error: {e}')
            # Fallback to test mode for development
            return jsonify({
                'valid': True,
                'clientCode': client_code,
                'pricingFormula': 'distance*10',
                'companyName': f'Test Company ({client_code})'
            })

    except Exception as error:
        print(f'Server error: {error}')
        return jsonify({'error': 'Error validating client code. Please try again.'}), 500

@app.route('/api/submit-booking', methods=['POST'])
def submit_booking():
    try:
        data = request.get_json()
        company_name = data.get('companyNameString')
        distance = data.get('distanceDouble')
        location_a = data.get('locationALocation')
        location_b = data.get('locationBLocation')
        price = data.get('priceDouble')
        
        if not all([company_name, distance, location_a, location_b, price]):
            return jsonify({'error': 'All booking fields are required'}), 400

        # Create the booking record for CloudKit
        booking_record = {
            "recordType": "SOTOWebsiteBookings",
            "fields": {
                "companyNameString": {
                    "value": company_name,
                    "type": "STRING"
                },
                "distanceDouble": {
                    "value": float(distance),
                    "type": "DOUBLE"
                },
                "locationALocation": {
                    "value": location_a,
                    "type": "STRING"
                },
                "locationBLocation": {
                    "value": location_b,
                    "type": "STRING"
                },
                "priceDouble": {
                    "value": float(price),
                    "type": "DOUBLE"
                }
            }
        }

        # Create the booking record for CloudKit
        booking_record = {
            "recordType": "SOTOWebsiteBookings",
            "fields": {
                "companyNameString": {
                    "value": company_name,
                    "type": "STRING"
                },
                "distanceDouble": {
                    "value": float(distance),
                    "type": "DOUBLE"
                },
                "locationALocation": {
                    "value": location_a,
                    "type": "STRING"
                },
                "locationBLocation": {
                    "value": location_b,
                    "type": "STRING"
                },
                "priceDouble": {
                    "value": float(price),
                    "type": "DOUBLE"
                }
            }
        }

        # Create signed request for booking submission
        modify_request = {
            "operations": [{
                "operationType": "create",
                "record": booking_record
            }]
        }
        
        # Create signed request for booking submission
        current_date = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
        request_body = json.dumps(modify_request)
        body_hash = hashlib.sha256(request_body.encode()).digest()
        body_hash_b64 = base64.b64encode(body_hash).decode()
        
        # Create the web service URL subpath for modify
        url_subpath = f'/database/1/{CONTAINER_ID}/public/records/modify'
        
        # Concatenate the parameters with colons
        message = f"{current_date}:{body_hash_b64}:{url_subpath}"
        
        # Load the private key and create ECDSA signature
        private_key = serialization.load_pem_private_key(
            PRIVATE_KEY.encode(),
            password=None,
            backend=default_backend()
        )
        
        # Sign the message with ECDSA
        signature = private_key.sign(
            message.encode(),
            ec.ECDSA(hashes.SHA256())
        )
        
        modify_headers = {
            'Content-Type': 'application/json',
            'X-Apple-CloudKit-Request-KeyID': KEY_ID,
            'X-Apple-CloudKit-Request-ISO8601Date': current_date,
            'X-Apple-CloudKit-Request-SignatureV1': base64.b64encode(signature).decode()
        }
        
        # Try to save the booking to CloudKit
        try:
            response = requests.post(
                f'{BASE_URL}/records/modify',
                headers=modify_headers,
                data=request_body
            )

            if response.ok:
                result = response.json()
                return jsonify({
                    'success': True,
                    'message': 'Booking submitted successfully',
                    'recordID': result.get('records', [{}])[0].get('recordName', 'unknown')
                })
            else:
                print(f'CloudKit booking save failed: {response.status_code} {response.text}')
                # Fallback to test mode for development
                print(f"Booking submitted (test mode): {company_name} - {location_a} to {location_b} - £{price}")
                return jsonify({
                    'success': True,
                    'message': 'Booking submitted successfully (test mode)',
                    'recordID': f'booking_{company_name}_{int(distance)}'
                })
                
        except Exception as e:
            print(f'CloudKit booking connection error: {e}')
            # Fallback to test mode for development
            print(f"Booking submitted (test mode): {company_name} - {location_a} to {location_b} - £{price}")
            return jsonify({
                'success': True,
                'message': 'Booking submitted successfully (test mode)',
                'recordID': f'booking_{company_name}_{int(distance)}'
            })

    except Exception as error:
        print(f'Server booking error: {error}')
        return jsonify({'error': 'Error submitting booking. Please try again.'}), 500

# SOTO-LP API Endpoints

@app.route('/api/soto-lp/add-job', methods=['POST'])
def add_job():
    """Add a new job to the database"""
    try:
        data = request.get_json()
        day_number = data.get('day_number')
        job_number = data.get('job_number')
        raw_text = data.get('raw_text')
        
        if not all([day_number, job_number, raw_text]):
            return jsonify({'error': 'Missing required fields'}), 400
        
        # Parse the job text using AI
        try:
            # Create AI processor with current environment variables
            current_ai_processor = SOTOLPAI(GOOGLE_AI_API_KEY, GOOGLE_MAPS_API_KEY)
            parsed_data = current_ai_processor.parse_job_text(raw_text)
        except Exception as e:
            print(f"AI parsing failed: {e}")
            # Demo mode - basic parsing
            parsed_data = {
                'collection_address': 'Demo Collection Address',
                'delivery_address': 'Demo Delivery Address',
                'price': 150.0,
                'postcode_collection': 'B772NZ',
                'postcode_delivery': 'B775NZ',
                'vehicle_details': 'Demo Vehicle',
                'contact_info': 'Demo Contact',
                'notes': 'Demo mode - add API keys for real parsing'
            }
        
        # Add job to database
        job_id = db.add_job(day_number, job_number, raw_text, parsed_data)
        
        return jsonify({
            'success': True,
            'job_id': job_id,
            'parsed_data': parsed_data
        })
        
    except Exception as e:
        print(f"Error adding job: {e}")
        return jsonify({'error': 'Failed to add job'}), 500

@app.route('/api/soto-lp/get-jobs', methods=['GET'])
def get_jobs():
    """Get all jobs or jobs for a specific day"""
    try:
        day_number = request.args.get('day')
        jobs = db.get_jobs_by_day(int(day_number) if day_number else None)
        
        return jsonify({
            'success': True,
            'jobs': jobs
        })
        
    except Exception as e:
        print(f"Error getting jobs: {e}")
        return jsonify({'error': 'Failed to get jobs'}), 500

@app.route('/api/soto-lp/add-driver', methods=['POST'])
def add_driver():
    """Add a new driver to the database"""
    try:
        data = request.get_json()
        name = data.get('name')
        postcode = data.get('postcode')
        
        if not all([name, postcode]):
            return jsonify({'error': 'Name and postcode are required'}), 400
        
        driver_id = db.add_driver(name, postcode)
        
        return jsonify({
            'success': True,
            'driver_id': driver_id
        })
        
    except Exception as e:
        print(f"Error adding driver: {e}")
        return jsonify({'error': 'Failed to add driver'}), 500

@app.route('/api/soto-lp/get-drivers', methods=['GET'])
def get_drivers():
    """Get all drivers"""
    try:
        drivers = db.get_drivers()
        
        return jsonify({
            'success': True,
            'drivers': drivers
        })
        
    except Exception as e:
        print(f"Error getting drivers: {e}")
        return jsonify({'error': 'Failed to get drivers'}), 500

@app.route('/api/soto-lp/process-matches', methods=['POST'])
def process_matches():
    """Process job matches for all jobs"""
    try:
        # Get all jobs and drivers
        jobs = db.get_jobs_by_day()
        drivers = db.get_drivers()
        
        if not jobs:
            return jsonify({'error': 'No jobs found'}), 400
        
        if not drivers:
            return jsonify({'error': 'No drivers found'}), 400
        
        # Clear existing matches
        db.clear_job_matches()
        
        # Process matches
        if ai_processor:
            all_matches = ai_processor.match_jobs_to_drivers(jobs, drivers)
        else:
            # Demo mode - create mock matches
            all_matches = []
            for job in jobs:
                for driver in drivers:
                    # Simple demo scoring
                    score = 8.5 if driver['postcode'].startswith('B77') else 7.0
                    all_matches.append({
                        'job_id': job['id'],
                        'driver_id': driver['id'],
                        'match_score': score,
                        'distance_miles': 5.2,
                        'reasoning': f"Demo match - {driver['name']} scored {score}/10"
                    })
        
        # Save matches to database
        for match in all_matches:
            db.add_job_match(
                match['job_id'],
                match['driver_id'],
                match['match_score'],
                match['distance_miles'],
                match['reasoning']
            )
        
        # Get formatted results
        results = db.get_job_matches()
        
        return jsonify({
            'success': True,
            'matches': results
        })
        
    except Exception as e:
        print(f"Error processing matches: {e}")
        return jsonify({'error': 'Failed to process matches'}), 500

@app.route('/api/soto-lp/get-matches', methods=['GET'])
def get_matches():
    """Get job matches"""
    try:
        job_id = request.args.get('job_id')
        matches = db.get_job_matches(int(job_id) if job_id else None)
        
        return jsonify({
            'success': True,
            'matches': matches
        })
        
    except Exception as e:
        print(f"Error getting matches: {e}")
        return jsonify({'error': 'Failed to get matches'}), 500

@app.route('/api/soto-lp/statistics', methods=['GET'])
def get_statistics():
    """Get database statistics"""
    try:
        stats = db.get_statistics()
        
        return jsonify({
            'success': True,
            'statistics': stats
        })
        
    except Exception as e:
        print(f"Error getting statistics: {e}")
        return jsonify({'error': 'Failed to get statistics'}), 500

@app.route('/api/routes/get/<user_id>', methods=['GET'])
def get_routes(user_id):
    try:
        # Query CloudKit for user's routes
        routes_query = {
            "recordType": "SOTOWebsiteROUTESRoutes",
                "recordType": "SOTOWebsiteROUTESRoutes",
                "fields": {
                    "routeIdString": {
                        "value": route.get('routeId', f"route_{int(time.time())}"),
                        "type": "STRING"
                    },
                    "userIdString": {
                        "value": user_id,
                        "type": "STRING"
                    },
                    "routeNameString": {
                        "value": route.get('routeName', 'Unnamed Route'),
                        "type": "STRING"
                    },
                    "driverNameString": {
                        "value": route.get('driverName', ''),
                        "type": "STRING"
                    },
                    "driverLocationString": {
                        "value": route.get('driverLocation', ''),
                        "type": "STRING"
                    },
                    "totalJobsInt64": {
                        "value": int(route.get('totalJobs', 0)),
                        "type": "INT64"
                    },
                    "totalDistanceDouble": {
                        "value": float(route.get('totalDistance', 0)),
                        "type": "DOUBLE"
                    },
                    "estimatedDurationInt64": {
                        "value": int(route.get('estimatedDuration', 0)),
                        "type": "INT64"
                    },
                    "statusString": {
                        "value": route.get('status', 'active'),
                        "type": "STRING"
                    },
                    "createdAtTimestamp": {
                        "value": route.get('timestamp', datetime.utcnow().isoformat() + 'Z'),
                        "type": "TIMESTAMP"
                    },
                    "updatedAtTimestamp": {
                        "value": datetime.utcnow().isoformat() + 'Z',
                        "type": "TIMESTAMP"
                    }
                }
            }
            route_records.append(route_record)

        # Create job records for CloudKit
        job_records = []
        for route in routes:
            route_id = route.get('routeId', '')
            for job in jobs:
                job_record = {
                    "recordType": "SOTOWebsiteROUTESJobs",
                    "fields": {
                        "jobIdString": {
                            "value": job.get('jobId', f"job_{int(time.time())}_{job.get('jobNumber', 1)}"),
                            "type": "STRING"
                        },
                        "routeIdString": {
                            "value": route_id,
                            "type": "STRING"
                        },
                        "jobNumberInt64": {
                            "value": int(job.get('jobNumber', 1)),
                            "type": "INT64"
                        },
                        "collectionAddressString": {
                            "value": job.get('collectionAddress', ''),
                            "type": "STRING"
                        },
                        "deliveryAddressString": {
                            "value": job.get('deliveryAddress', ''),
                            "type": "STRING"
                        },
                        "collectionPostcodeString": {
                            "value": job.get('collectionPostcode', ''),
                            "type": "STRING"
                        },
                        "deliveryPostcodeString": {
                            "value": job.get('deliveryPostcode', ''),
                            "type": "STRING"
                        },
                        "jobPriceDouble": {
                            "value": float(job.get('price', 0)),
                            "type": "DOUBLE"
                        },
                        "jobDistanceDouble": {
                            "value": float(job.get('distance', 0)),
                            "type": "DOUBLE"
                        },
                        "jobDurationInt64": {
                            "value": int(job.get('duration', 0)),
                            "type": "INT64"
                        },
                        "jobNotesString": {
                            "value": job.get('notes', ''),
                            "type": "STRING"
                        },
                        "isCompletedBoolean": {
                            "value": 1 if job.get('isCompleted', False) else 0,
                            "type": "INT64"
                        },
                        "createdAtTimestamp": {
                            "value": job.get('timestamp', datetime.utcnow().isoformat() + 'Z'),
                            "type": "TIMESTAMP"
                        }
                    }
                }
                job_records.append(job_record)

        # Create signed request for CloudKit (routes first, then jobs)
        all_records = route_records + job_records
        modify_request = {
            "operations": [{"operationType": "create", "record": record} for record in all_records]
        }
        
        # Create signed request manually (like booking submission)
        current_date = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
        request_body = json.dumps(modify_request)
        body_hash = hashlib.sha256(request_body.encode()).digest()
        body_hash_b64 = base64.b64encode(body_hash).decode()
        
        # Create the web service URL subpath for modify
        url_subpath = f'/database/1/{CONTAINER_ID}/public/records/modify'
        
        # Concatenate the parameters with colons
        message = f"{current_date}:{body_hash_b64}:{url_subpath}"
        
        # Load the private key and create ECDSA signature
        private_key = serialization.load_pem_private_key(
            PRIVATE_KEY.encode(),
            password=None,
            backend=default_backend()
        )
        
        # Sign the message with ECDSA
        signature = private_key.sign(
            message.encode(),
            ec.ECDSA(hashes.SHA256())
        )
        
        # Use token-based authentication (same as working client validation)
        headers = {
            'Content-Type': 'application/json',
            'X-CloudKit-Protocol-Version': '1',
            'Authorization': f'Bearer {CLOUDKIT_TOKEN}'
        }
        
        # Make request to CloudKit
        response = requests.post(
            f'{BASE_URL}/records/modify',
            headers=headers,
            json=modify_request
        )

        if response.ok:
            return jsonify({'success': True, 'message': f'{len(routes)} routes and {len(jobs)} jobs saved successfully to CloudKit'})
        else:
            print(f'CloudKit error response: {response.status_code} - {response.text}')
            return jsonify({
                'success': False, 
                'error': f'Failed to save routes to CloudKit: {response.status_code} - {response.text}'
            })

    except Exception as error:
        print(f'Error saving routes: {error}')
        return jsonify({'error': 'Error saving routes. Please try again.'}), 500

@app.route('/api/routes/get/<user_id>', methods=['GET'])
def get_routes(user_id):
    try:
        # Query CloudKit for user's routes
        routes_query = {
            "recordType": "SOTOWebsiteROUTESRoutes",
            "filterBy": [{
                "fieldName": "userIdString",
                "comparator": "EQUALS",
                "fieldValue": {
                    "value": user_id,
                    "type": "STRING"
                }
            }]
        }

        # Use token-based authentication (same as working client validation)
        headers = {
            'Content-Type': 'application/json',
            'X-CloudKit-Protocol-Version': '1',
            'Authorization': f'Bearer {CLOUDKIT_TOKEN}'
        }
        
        response = requests.post(
            f'{BASE_URL}/records/query',
            headers=headers,
            json=routes_query
        )

        if response.ok:
            data = response.json()
            routes = []
            
            if data.get('records'):
                for route_record in data['records']:
                    route_id = route_record['fields'].get('routeIdString', {}).get('value', route_record['recordName'])
                    
                    # Get jobs for this route
                    jobs_query = {
                        "recordType": "SOTOWebsiteROUTESJobs",
                        "filterBy": [{
                            "fieldName": "routeIdString",
                            "comparator": "EQUALS",
                            "fieldValue": {
                                "value": route_id,
                                "type": "STRING"
                            }
                        }],
                        "sortBy": [{
                            "fieldName": "jobNumberInt64",
                            "ascending": True
                        }]
                    }
                    
                    # Use token-based authentication for jobs query
                    jobs_response = requests.post(
                        f'{BASE_URL}/records/query',
                        headers=headers,
                        json=jobs_query
                    )
                    
                    jobs = []
                    if jobs_response.ok:
                        jobs_data = jobs_response.json()
                        if jobs_data.get('records'):
                            for job_record in jobs_data['records']:
                                job = {
                                    'jobId': job_record['fields'].get('jobIdString', {}).get('value', job_record['recordName']),
                                    'jobNumber': job_record['fields'].get('jobNumberInt64', {}).get('value', 1),
                                    'collection': job_record['fields'].get('collectionAddressString', {}).get('value', ''),
                                    'delivery': job_record['fields'].get('deliveryAddressString', {}).get('value', ''),
                                    'collectionPostcode': job_record['fields'].get('collectionPostcodeString', {}).get('value', ''),
                                    'deliveryPostcode': job_record['fields'].get('deliveryPostcodeString', {}).get('value', ''),
                                    'price': job_record['fields'].get('jobPriceDouble', {}).get('value', 0),
                                    'distance': job_record['fields'].get('jobDistanceDouble', {}).get('value', 0),
                                    'duration': job_record['fields'].get('jobDurationInt64', {}).get('value', 0),
                                    'notes': job_record['fields'].get('jobNotesString', {}).get('value', ''),
                                    'isCompleted': job_record['fields'].get('isCompletedBoolean', {}).get('value', 0) == 1,
                                    'createdAt': job_record['fields'].get('createdAtTimestamp', {}).get('value', '')
                                }
                                jobs.append(job)
                    
                    # Create route with jobs
                    route = {
                        'id': route_id,
                        'driver': route_record['fields'].get('driverNameString', {}).get('value', ''),
                        'driverLocation': route_record['fields'].get('driverLocationString', {}).get('value', ''),
                        'totalDistance': route_record['fields'].get('totalDistanceDouble', {}).get('value', 0),
                        'estimatedDuration': route_record['fields'].get('estimatedDurationInt64', {}).get('value', 0),
                        'totalJobs': route_record['fields'].get('totalJobsInt64', {}).get('value', len(jobs)),
                        'status': route_record['fields'].get('statusString', {}).get('value', 'active'),
                        'createdAt': route_record['fields'].get('createdAtTimestamp', {}).get('value', ''),
                        'updatedAt': route_record['fields'].get('updatedAtTimestamp', {}).get('value', ''),
                        'routeName': route_record['fields'].get('routeNameString', {}).get('value', 'Unnamed Route'),
                        'jobs': jobs
                    }
                    routes.append(route)
            
            return jsonify({'success': True, 'routes': routes})
        else:
            return jsonify({'error': 'Failed to fetch routes from CloudKit'}), 500

    except Exception as error:
        print(f'Error getting routes: {error}')
        return jsonify({'error': 'Error fetching routes. Please try again.'}), 500

@app.route('/api/routes/clear/<user_id>', methods=['POST'])
def clear_routes(user_id):
    try:
        # First, get all route records for the user
        routes_query = {
            "recordType": "SOTOWebsiteROUTESRoutes",
            "filterBy": [{
                "fieldName": "userIdString",
                "comparator": "EQUALS",
                "fieldValue": {
                    "value": user_id,
                    "type": "STRING"
                }
            }]
        }

        signed_request = create_signed_request(routes_query)
        
        response = requests.post(
            f'{BASE_URL}/records/query',
            headers=signed_request['headers'],
            json=routes_query
        )

        if response.ok:
            data = response.json()
            
            if data.get('records'):
                # Get all job records for these routes first
                route_ids = [record['fields'].get('routeIdString', {}).get('value', record['recordName']) for record in data['records']]
                
                # Delete all job records for these routes
                job_delete_operations = []
                for route_id in route_ids:
                    jobs_query = {
                        "recordType": "SOTOWebsiteROUTESJobs",
                        "filterBy": [{
                            "fieldName": "routeIdString",
                            "comparator": "EQUALS",
                            "fieldValue": {
                                "value": route_id,
                                "type": "STRING"
                            }
                        }]
                    }
                    
                    # Use token-based authentication for jobs query
                    jobs_response = requests.post(
                        f'{BASE_URL}/records/query',
                        headers=headers,
                        json=jobs_query
                    )
                    
                    if jobs_response.ok:
                        jobs_data = jobs_response.json()
                        if jobs_data.get('records'):
                            for job_record in jobs_data['records']:
                                job_delete_operations.append({
                                    "operationType": "forceDelete",
                                    "recordName": job_record['recordName']
                                })
                
                # Delete all job records
                if job_delete_operations:
                    job_delete_request = {"operations": job_delete_operations}
                    job_delete_signed_request = create_signed_request(job_delete_request, 'modify')
                    
                    job_delete_response = requests.post(
                        f'{BASE_URL}/records/modify',
                        headers=job_delete_signed_request['headers'],
                        json=job_delete_request
                    )
                    
                    if not job_delete_response.ok:
                        print(f'Warning: Failed to delete some job records: {job_delete_response.status_code}')
                
                # Delete all route records
                route_delete_operations = []
                for record in data['records']:
                    route_delete_operations.append({
                        "operationType": "forceDelete",
                        "recordName": record['recordName']
                    })
                
                # Create delete request for routes
                route_delete_request = {"operations": route_delete_operations}
                route_delete_signed_request = create_signed_request(route_delete_request, 'modify')
                
                route_delete_response = requests.post(
                    f'{BASE_URL}/records/modify',
                    headers=route_delete_signed_request['headers'],
                    json=route_delete_request
                )
                
                if route_delete_response.ok:
                    return jsonify({'success': True, 'message': f'{len(data["records"])} routes and {len(job_delete_operations)} jobs deleted successfully'})
                else:
                    return jsonify({'error': 'Failed to delete routes from CloudKit'}), 500
            else:
                return jsonify({'success': True, 'message': 'No routes found to delete'})
        else:
            return jsonify({'error': 'Failed to fetch routes for deletion'}), 500

    except Exception as error:
        print(f'Error clearing routes: {error}')
        return jsonify({'error': 'Error clearing routes. Please try again.'}), 500

@app.route('/api/routes/save', methods=['POST'])
def save_route():
    """Save a route and its jobs to CloudKit using server-to-server authentication"""
    try:
        data = request.json
        print(f'Received data: {data}')
        
        if not data:
            return jsonify({'error': 'No JSON data received'}), 400
            
        route_data = data.get('route')
        jobs_data = data.get('jobs', [])
        
        print(f'Route data: {route_data}')
        print(f'Jobs data: {jobs_data}')
        
        if not route_data:
            return jsonify({'error': 'Route data is required'}), 400
            
        if not jobs_data:
            return jsonify({'error': 'Jobs data is required'}), 400
        
        print(f'Saving route to CloudKit: {route_data}')
        print(f'Saving jobs to CloudKit: {jobs_data}')
        
        # Create route record
        route_record = {
            'recordType': 'SOTOWebsiteROUTESRoutes',
            'fields': {
                'routeIdString': {'value': route_data.get('routeId')},
                'userIdString': {'value': route_data.get('userId')},
                'routeNameString': {'value': route_data.get('routeName')},
                'driverNameString': {'value': route_data.get('driverName', 'Default Driver')},
                'driverLocationString': {'value': route_data.get('driverLocation', 'Default Location')},
                'totalJobsInt64': {'value': len(jobs_data)},
                'totalDistanceDouble': {'value': route_data.get('totalDistance', 0)},
                'estimatedDurationInt64': {'value': route_data.get('estimatedDuration', 0)},
                'statusString': {'value': route_data.get('status', 'Pending')},
                'createdAtTimestamp': {'value': route_data.get('createdAt')},
                'updatedAtTimestamp': {'value': route_data.get('updatedAt')}
            }
        }
        
        # Create job records
        job_records = []
        for job in jobs_data:
            job_record = {
                'recordType': 'SOTOWebsiteROUTESJobs',
                'fields': {
                    'jobIdString': {'value': job.get('jobId')},
                    'routeIdString': {'value': route_data.get('routeId')},
                    'jobNumberInt64': {'value': job.get('jobNumber')},
                    'collectionAddressString': {'value': job.get('collectionAddress')},
                    'deliveryAddressString': {'value': job.get('deliveryAddress')},
                    'collectionPostcodeString': {'value': job.get('collectionPostcode', '')},
                    'deliveryPostcodeString': {'value': job.get('deliveryPostcode', '')},
                    'jobPriceDouble': {'value': job.get('price', 0)},
                    'jobDistanceDouble': {'value': job.get('distance', 0)},
                    'jobDurationInt64': {'value': job.get('duration', 0)},
                    'jobNotesString': {'value': job.get('notes', '')},
                    'isCompletedInt64': {'value': 1 if job.get('isCompleted', False) else 0},
                    'createdAtTimestamp': {'value': job.get('createdAt')}
                }
            }
            job_records.append(job_record)
        
        # Prepare the modify request
        modify_request = {
            'operations': [
                {'operationType': 'create', 'record': route_record}
            ] + [
                {'operationType': 'create', 'record': job_record} for job_record in job_records
            ]
        }
        
        print(f'CloudKit modify request: {modify_request}')
        
        # Send to CloudKit using server-to-server authentication
        response = create_signed_request(modify_request, 'modify')
        
        print(f'CloudKit response status: {response.status_code}')
        print(f'CloudKit response: {response.text}')
        
        if response.status_code == 200:
            return jsonify({
                'success': True,
                'message': 'Route saved successfully to CloudKit',
                'routeId': route_data.get('routeId')
            })
        else:
            return jsonify({
                'error': f'CloudKit error: {response.status_code} - {response.text}'
            }), response.status_code
            
    except Exception as e:
        print(f'Error saving route: {e}')
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("Starting Flask server on http://localhost:8000")
    print("CloudKit proxy ready for client validation and booking submissions")
    print("SOTO-LP API ready for logistics planning")
    app.run(host='0.0.0.0', port=8000, debug=True) 