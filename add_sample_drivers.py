#!/usr/bin/env python3
"""
Script to add sample drivers to the SOTO-LP database
"""

from soto_lp_database import SOTOLPDatabase

def add_sample_drivers():
    """Add sample drivers to the database"""
    db = SOTOLPDatabase()
    
    # Sample drivers with UK postcodes
    sample_drivers = [
        ("John Smith", "B772NZ"),
        ("Sarah Johnson", "B775NZ"), 
        ("Mike Wilson", "B780AB"),
        ("Emma Davis", "B785CD"),
        ("Tom Brown", "M1 1AA"),
        ("Lisa Green", "M2 2BB"),
        ("James White", "L1 1CC"),
        ("Anna Black", "L2 2DD"),
        ("David Taylor", "S1 1EE"),
        ("Rachel Miller", "S2 2FF")
    ]
    
    print("Adding sample drivers to SOTO-LP database...")
    
    for name, postcode in sample_drivers:
        try:
            driver_id = db.add_driver(name, postcode)
            print(f"✓ Added driver: {name} ({postcode}) - ID: {driver_id}")
        except Exception as e:
            print(f"✗ Error adding {name}: {e}")
    
    # Get statistics
    stats = db.get_statistics()
    print(f"\nDatabase Statistics:")
    print(f"Total drivers: {stats['driver_count']}")
    print(f"Total jobs: {stats['job_count']}")
    print(f"Total matches: {stats['match_count']}")

if __name__ == "__main__":
    add_sample_drivers()
