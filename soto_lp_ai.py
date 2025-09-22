import google.generativeai as genai
import googlemaps
import re
import os
from typing import Dict, List, Optional

class SOTOLPAI:
    def __init__(self, google_ai_api_key: str, google_maps_api_key: str):
        # Configure Google AI
        genai.configure(api_key=google_ai_api_key)
        self.model = genai.GenerativeModel('gemini-2.0-flash-lite')
        
        # Configure Google Maps
        self.gmaps = googlemaps.Client(key=google_maps_api_key)
        
        # Simple cache for parsed results
        self.cache = {}
    
    def parse_job_text(self, job_text: str) -> Dict:
        """
        Parse job text using Google AI to extract structured data with confidence scores
        """
        # Check cache first
        cache_key = hash(job_text.strip())
        if cache_key in self.cache:
            print("Using cached result")
            return self.cache[cache_key]
        
        prompt = f"""
        Parse the following job text and extract the following information in JSON format:
        
        {job_text}
        
        Extract:
        - collection_address: The pickup/collection address
        - delivery_address: The delivery address  
        - price: The price as a number (extract just the number, no currency symbols)
        - postcode_collection: The postcode from the collection address
        - postcode_delivery: The postcode from the delivery address
        - vehicle_details: Any vehicle information (make, model, reg, etc.)
        - contact_info: Any contact information
        - notes: Any additional notes or special instructions
        
        For each field, also provide a confidence score (0-100) indicating how confident you are in the extraction.
        
        Return ONLY valid JSON in this exact format:
        {{
            "collection_address": "full address",
            "delivery_address": "full address", 
            "price": 123.45,
            "postcode_collection": "AB12CD",
            "postcode_delivery": "EF34GH",
            "vehicle_details": "vehicle info",
            "contact_info": "contact details",
            "notes": "additional notes",
            "confidence_scores": {{
                "collection_address": 95,
                "delivery_address": 90,
                "price": 85,
                "postcode_collection": 80,
                "postcode_delivery": 85,
                "vehicle_details": 70,
                "contact_info": 60,
                "notes": 90
            }},
            "parsing_quality": "high|medium|low",
            "missing_fields": ["field1", "field2"],
            "uncertain_fields": ["field1", "field2"]
        }}
        """
        
        try:
            response = self.model.generate_content(prompt)
            result_text = response.text.strip()
            
            # Clean up the response to extract JSON
            if '```json' in result_text:
                result_text = result_text.split('```json')[1].split('```')[0]
            elif '```' in result_text:
                result_text = result_text.split('```')[1].split('```')[0]
            
            # Parse JSON
            import json
            parsed_data = json.loads(result_text)
            
            # Validate and clean the data with confidence scores
            result = self._clean_parsed_data_with_confidence(parsed_data)
            
            # Cache the result
            self.cache[cache_key] = result
            return result
            
        except Exception as e:
            print(f"Error parsing job text with AI: {e}")
            print(f"Error type: {type(e)}")
            import traceback
            print(f"Traceback: {traceback.format_exc()}")
            # Fallback to basic regex parsing with low confidence
            return self._fallback_parse_with_confidence(job_text)
    
    def _clean_parsed_data_with_confidence(self, data: Dict) -> Dict:
        """Clean and validate parsed data with confidence scores"""
        # Extract confidence scores
        confidence_scores = data.get('confidence_scores', {})
        
        # Safely convert all fields to strings, handling None and numeric values
        def safe_str_convert(value):
            if value is None:
                return ''
            return str(value).strip()
        
        cleaned = {
            'collection_address': safe_str_convert(data.get('collection_address', '')),
            'delivery_address': safe_str_convert(data.get('delivery_address', '')),
            'price': float(data.get('price', 0)) if data.get('price') else 0,
            'postcode_collection': safe_str_convert(data.get('postcode_collection', '')).upper(),
            'postcode_delivery': safe_str_convert(data.get('postcode_delivery', '')).upper(),
            'vehicle_details': safe_str_convert(data.get('vehicle_details', '')),
            'contact_info': safe_str_convert(data.get('contact_info', '')),
            'notes': safe_str_convert(data.get('notes', '')),
            'confidence_scores': {
                'collection_address': int(confidence_scores.get('collection_address', 0)),
                'delivery_address': int(confidence_scores.get('delivery_address', 0)),
                'price': int(confidence_scores.get('price', 0)),
                'postcode_collection': int(confidence_scores.get('postcode_collection', 0)),
                'postcode_delivery': int(confidence_scores.get('postcode_delivery', 0)),
                'vehicle_details': int(confidence_scores.get('vehicle_details', 0)),
                'contact_info': int(confidence_scores.get('contact_info', 0)),
                'notes': int(confidence_scores.get('notes', 0))
            },
            'parsing_quality': data.get('parsing_quality', 'low'),
            'missing_fields': data.get('missing_fields', []),
            'uncertain_fields': data.get('uncertain_fields', [])
        }
        
        # Extract postcodes if not provided
        if not cleaned['postcode_collection'] and cleaned['collection_address']:
            extracted_postcode = self._extract_postcode(cleaned['collection_address'])
            if extracted_postcode:
                cleaned['postcode_collection'] = extracted_postcode
                cleaned['confidence_scores']['postcode_collection'] = 75  # Medium confidence for regex extraction
        
        if not cleaned['postcode_delivery'] and cleaned['delivery_address']:
            extracted_postcode = self._extract_postcode(cleaned['delivery_address'])
            if extracted_postcode:
                cleaned['postcode_delivery'] = extracted_postcode
                cleaned['confidence_scores']['postcode_delivery'] = 75  # Medium confidence for regex extraction
        
        # Calculate overall confidence score
        confidence_values = list(cleaned['confidence_scores'].values())
        cleaned['overall_confidence'] = round(sum(confidence_values) / len(confidence_values), 1) if confidence_values else 0
        
        # Determine accuracy rating
        cleaned['accuracy_rating'] = self._calculate_accuracy_rating(cleaned)
        
        return cleaned
    
    def _clean_parsed_data(self, data: Dict) -> Dict:
        """Clean and validate parsed data (legacy method)"""
        cleaned = {
            'collection_address': str(data.get('collection_address', '')).strip(),
            'delivery_address': str(data.get('delivery_address', '')).strip(),
            'price': float(data.get('price', 0)) if data.get('price') else 0,
            'postcode_collection': str(data.get('postcode_collection', '')).strip().upper(),
            'postcode_delivery': str(data.get('postcode_delivery', '')).strip().upper(),
            'vehicle_details': str(data.get('vehicle_details', '')).strip(),
            'contact_info': str(data.get('contact_info', '')).strip(),
            'notes': str(data.get('notes', '')).strip()
        }
        
        # Extract postcodes if not provided
        if not cleaned['postcode_collection'] and cleaned['collection_address']:
            cleaned['postcode_collection'] = self._extract_postcode(cleaned['collection_address'])
        
        if not cleaned['postcode_delivery'] and cleaned['delivery_address']:
            cleaned['postcode_delivery'] = self._extract_postcode(cleaned['delivery_address'])
        
        return cleaned
    
    def _extract_postcode(self, address: str) -> str:
        """Extract UK postcode from address using regex"""
        # UK postcode pattern
        postcode_pattern = r'\b[A-Z]{1,2}[0-9R][0-9A-Z]? [0-9][A-Z]{2}\b'
        matches = re.findall(postcode_pattern, address.upper())
        return matches[0] if matches else ''
    
    def _calculate_accuracy_rating(self, data: Dict) -> str:
        """Calculate accuracy rating based on confidence scores and data quality"""
        overall_confidence = data.get('overall_confidence', 0)
        missing_fields = len(data.get('missing_fields', []))
        uncertain_fields = len(data.get('uncertain_fields', []))
        
        # Critical fields that must be present
        critical_fields = ['collection_address', 'delivery_address', 'price']
        critical_missing = sum(1 for field in critical_fields if not str(data.get(field, '')).strip())
        
        # Calculate rating
        if overall_confidence >= 85 and critical_missing == 0 and missing_fields <= 1:
            return 'excellent'
        elif overall_confidence >= 70 and critical_missing <= 1 and missing_fields <= 2:
            return 'good'
        elif overall_confidence >= 50 and critical_missing <= 2:
            return 'fair'
        else:
            return 'poor'
    
    def _fallback_parse_with_confidence(self, job_text: str) -> Dict:
        """Fallback parsing using regex when AI fails, with confidence scores"""
        # Extract price
        price_match = re.search(r'[£$]?(\d+\.?\d*)', job_text)
        price = float(price_match.group(1)) if price_match else 0
        
        # Extract postcodes
        postcode_pattern = r'\b[A-Z]{1,2}[0-9R][0-9A-Z]? [0-9][A-Z]{2}\b'
        postcodes = re.findall(postcode_pattern, job_text.upper())
        
        # Low confidence scores for regex fallback
        confidence_scores = {
            'collection_address': 0,
            'delivery_address': 0,
            'price': 60 if price_match else 0,
            'postcode_collection': 50 if len(postcodes) > 0 else 0,
            'postcode_delivery': 50 if len(postcodes) > 1 else 0,
            'vehicle_details': 0,
            'contact_info': 0,
            'notes': 80
        }
        
        result = {
            'collection_address': '',
            'delivery_address': '',
            'price': price,
            'postcode_collection': postcodes[0] if len(postcodes) > 0 else '',
            'postcode_delivery': postcodes[1] if len(postcodes) > 1 else '',
            'vehicle_details': '',
            'contact_info': '',
            'notes': job_text,
            'confidence_scores': confidence_scores,
            'parsing_quality': 'low',
            'missing_fields': ['collection_address', 'delivery_address', 'vehicle_details', 'contact_info'],
            'uncertain_fields': ['price', 'postcode_collection', 'postcode_delivery']
        }
        
        # Calculate overall confidence
        confidence_values = list(confidence_scores.values())
        result['overall_confidence'] = round(sum(confidence_values) / len(confidence_values), 1) if confidence_values else 0
        result['accuracy_rating'] = self._calculate_accuracy_rating(result)
        
        return result
    
    def _fallback_parse(self, job_text: str) -> Dict:
        """Fallback parsing using regex when AI fails (legacy method)"""
        # Extract price
        price_match = re.search(r'[£$]?(\d+\.?\d*)', job_text)
        price = float(price_match.group(1)) if price_match else 0
        
        # Extract postcodes
        postcode_pattern = r'\b[A-Z]{1,2}[0-9R][0-9A-Z]? [0-9][A-Z]{2}\b'
        postcodes = re.findall(postcode_pattern, job_text.upper())
        
        return {
            'collection_address': '',
            'delivery_address': '',
            'price': price,
            'postcode_collection': postcodes[0] if len(postcodes) > 0 else '',
            'postcode_delivery': postcodes[1] if len(postcodes) > 1 else '',
            'vehicle_details': '',
            'contact_info': '',
            'notes': job_text
        }
    
    def calculate_distance(self, origin: str, destination: str) -> Dict:
        """
        Calculate distance between two addresses using Google Maps
        """
        try:
            # Geocode addresses to get coordinates
            origin_geocode = self.gmaps.geocode(origin)
            dest_geocode = self.gmaps.geocode(destination)
            
            if not origin_geocode or not dest_geocode:
                return {'distance_miles': 0, 'duration_minutes': 0, 'error': 'Could not geocode addresses'}
            
            origin_coords = origin_geocode[0]['geometry']['location']
            dest_coords = dest_geocode[0]['geometry']['location']
            
            # Calculate distance using Directions API
            directions = self.gmaps.directions(
                origin=origin_coords,
                destination=dest_coords,
                mode="driving",
                units="imperial"
            )
            
            if directions and len(directions) > 0:
                route = directions[0]['legs'][0]
                distance_miles = route['distance']['value'] * 0.000621371  # Convert meters to miles
                duration_minutes = route['duration']['value'] / 60  # Convert seconds to minutes
                
                return {
                    'distance_miles': round(distance_miles, 2),
                    'duration_minutes': round(duration_minutes, 2),
                    'error': None
                }
            else:
                return {'distance_miles': 0, 'duration_minutes': 0, 'error': 'No route found'}
                
        except Exception as e:
            print(f"Error calculating distance: {e}")
            return {'distance_miles': 0, 'duration_minutes': 0, 'error': str(e)}
    
    def calculate_postcode_distance(self, postcode1: str, postcode2: str) -> Dict:
        """
        Calculate distance between two UK postcodes
        """
        try:
            # Use postcode lookup service or geocoding
            directions = self.gmaps.directions(
                origin=postcode1,
                destination=postcode2,
                mode="driving",
                units="imperial"
            )
            
            if directions and len(directions) > 0:
                route = directions[0]['legs'][0]
                distance_miles = route['distance']['value'] * 0.000621371
                duration_minutes = route['duration']['value'] / 60
                
                return {
                    'distance_miles': round(distance_miles, 2),
                    'duration_minutes': round(duration_minutes, 2),
                    'error': None
                }
            else:
                return {'distance_miles': 0, 'duration_minutes': 0, 'error': 'No route found'}
                
        except Exception as e:
            print(f"Error calculating postcode distance: {e}")
            return {'distance_miles': 0, 'duration_minutes': 0, 'error': str(e)}
    
    def match_jobs_to_drivers(self, jobs: List[Dict], drivers: List[Dict]) -> List[Dict]:
        """
        Match jobs to drivers based on proximity and other factors
        """
        matches = []
        
        for job in jobs:
            if not job.get('postcode_delivery'):
                continue
                
            job_matches = []
            
            for driver in drivers:
                if not driver.get('postcode'):
                    continue
                
                # Calculate distance from job delivery to driver home
                distance_result = self.calculate_postcode_distance(
                    job['postcode_delivery'], 
                    driver['postcode']
                )
                
                if distance_result['error']:
                    continue
                
                distance_miles = distance_result['distance_miles']
                
                # Calculate match score (0-10)
                # Closer distance = higher score
                # Price factor (higher price = higher score)
                price_score = min(job.get('price', 0) / 20, 5)  # Max 5 points for price
                distance_score = max(0, 5 - (distance_miles / 10))  # Max 5 points for distance
                
                total_score = round(price_score + distance_score, 1)
                
                job_matches.append({
                    'driver_id': driver['id'],
                    'driver_name': driver['name'],
                    'driver_postcode': driver['postcode'],
                    'match_score': total_score,
                    'distance_miles': distance_miles,
                    'reasoning': f"Price: £{job.get('price', 0)} ({price_score:.1f}/5), Distance: {distance_miles:.1f}mi ({distance_score:.1f}/5)"
                })
            
            # Sort by match score (highest first)
            job_matches.sort(key=lambda x: x['match_score'], reverse=True)
            
            matches.extend(job_matches)
        
        return matches
