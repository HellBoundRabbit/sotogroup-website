import sqlite3
import json
from datetime import datetime

class SOTOLPDatabase:
    def __init__(self, db_path='soto_lp.db'):
        self.db_path = db_path
        self.init_database()
    
    def init_database(self):
        """Initialize the SQLite database with required tables"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Drivers table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS drivers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                postcode TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Jobs table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                day_number INTEGER NOT NULL,
                job_number INTEGER NOT NULL,
                raw_text TEXT NOT NULL,
                collection_address TEXT,
                delivery_address TEXT,
                price REAL,
                postcode_collection TEXT,
                postcode_delivery TEXT,
                parsed_data TEXT,  -- JSON string of all parsed data
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Job matches table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS job_matches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                driver_id INTEGER NOT NULL,
                match_score REAL NOT NULL,
                distance_miles REAL,
                reasoning TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (job_id) REFERENCES jobs (id),
                FOREIGN KEY (driver_id) REFERENCES drivers (id)
            )
        ''')
        
        conn.commit()
        conn.close()
    
    def add_driver(self, name, postcode):
        """Add a new driver to the database"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO drivers (name, postcode) VALUES (?, ?)
        ''', (name, postcode))
        
        driver_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return driver_id
    
    def get_drivers(self):
        """Get all drivers from the database"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('SELECT id, name, postcode FROM drivers ORDER BY name')
        drivers = cursor.fetchall()
        
        conn.close()
        return [{'id': row[0], 'name': row[1], 'postcode': row[2]} for row in drivers]
    
    def add_job(self, day_number, job_number, raw_text, parsed_data=None):
        """Add a new job to the database"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Extract parsed data if provided
        collection_address = parsed_data.get('collection_address', '') if parsed_data else ''
        delivery_address = parsed_data.get('delivery_address', '') if parsed_data else ''
        price = parsed_data.get('price', 0) if parsed_data else 0
        postcode_collection = parsed_data.get('postcode_collection', '') if parsed_data else ''
        postcode_delivery = parsed_data.get('postcode_delivery', '') if parsed_data else ''
        parsed_json = json.dumps(parsed_data) if parsed_data else ''
        
        cursor.execute('''
            INSERT INTO jobs (day_number, job_number, raw_text, collection_address, 
                            delivery_address, price, postcode_collection, postcode_delivery, parsed_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (day_number, job_number, raw_text, collection_address, delivery_address, 
              price, postcode_collection, postcode_delivery, parsed_json))
        
        job_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return job_id
    
    def get_jobs_by_day(self, day_number=None):
        """Get jobs, optionally filtered by day"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        if day_number:
            cursor.execute('''
                SELECT id, day_number, job_number, raw_text, collection_address, 
                       delivery_address, price, postcode_collection, postcode_delivery, parsed_data
                FROM jobs WHERE day_number = ? ORDER BY job_number
            ''', (day_number,))
        else:
            cursor.execute('''
                SELECT id, day_number, job_number, raw_text, collection_address, 
                       delivery_address, price, postcode_collection, postcode_delivery, parsed_data
                FROM jobs ORDER BY day_number, job_number
            ''')
        
        jobs = cursor.fetchall()
        conn.close()
        
        return [{
            'id': row[0],
            'day_number': row[1],
            'job_number': row[2],
            'raw_text': row[3],
            'collection_address': row[4],
            'delivery_address': row[5],
            'price': row[6],
            'postcode_collection': row[7],
            'postcode_delivery': row[8],
            'parsed_data': json.loads(row[9]) if row[9] else None
        } for row in jobs]
    
    def add_job_match(self, job_id, driver_id, match_score, distance_miles=None, reasoning=None):
        """Add a job match result"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO job_matches (job_id, driver_id, match_score, distance_miles, reasoning)
            VALUES (?, ?, ?, ?, ?)
        ''', (job_id, driver_id, match_score, distance_miles, reasoning))
        
        match_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return match_id
    
    def get_job_matches(self, job_id=None):
        """Get job matches, optionally filtered by job"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        if job_id:
            cursor.execute('''
                SELECT jm.id, jm.job_id, jm.driver_id, jm.match_score, jm.distance_miles, 
                       jm.reasoning, d.name, d.postcode, j.day_number, j.job_number
                FROM job_matches jm
                JOIN drivers d ON jm.driver_id = d.id
                JOIN jobs j ON jm.job_id = j.id
                WHERE jm.job_id = ?
                ORDER BY jm.match_score DESC
            ''', (job_id,))
        else:
            cursor.execute('''
                SELECT jm.id, jm.job_id, jm.driver_id, jm.match_score, jm.distance_miles, 
                       jm.reasoning, d.name, d.postcode, j.day_number, j.job_number
                FROM job_matches jm
                JOIN drivers d ON jm.driver_id = d.id
                JOIN jobs j ON jm.job_id = j.id
                ORDER BY j.day_number, j.job_number, jm.match_score DESC
            ''')
        
        matches = cursor.fetchall()
        conn.close()
        
        return [{
            'id': row[0],
            'job_id': row[1],
            'driver_id': row[2],
            'match_score': row[3],
            'distance_miles': row[4],
            'reasoning': row[5],
            'driver_name': row[6],
            'driver_postcode': row[7],
            'day_number': row[8],
            'job_number': row[9]
        } for row in matches]
    
    def clear_job_matches(self, job_id=None):
        """Clear job matches, optionally for a specific job"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        if job_id:
            cursor.execute('DELETE FROM job_matches WHERE job_id = ?', (job_id,))
        else:
            cursor.execute('DELETE FROM job_matches')
        
        conn.commit()
        conn.close()
    
    def get_statistics(self):
        """Get database statistics"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Count drivers
        cursor.execute('SELECT COUNT(*) FROM drivers')
        driver_count = cursor.fetchone()[0]
        
        # Count jobs
        cursor.execute('SELECT COUNT(*) FROM jobs')
        job_count = cursor.fetchone()[0]
        
        # Count job matches
        cursor.execute('SELECT COUNT(*) FROM job_matches')
        match_count = cursor.fetchone()[0]
        
        # Get jobs by day
        cursor.execute('''
            SELECT day_number, COUNT(*) as job_count 
            FROM jobs 
            GROUP BY day_number 
            ORDER BY day_number
        ''')
        jobs_by_day = cursor.fetchall()
        
        conn.close()
        
        return {
            'driver_count': driver_count,
            'job_count': job_count,
            'match_count': match_count,
            'jobs_by_day': [{'day': row[0], 'count': row[1]} for row in jobs_by_day]
        }
