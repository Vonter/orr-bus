#!/usr/bin/env python3
"""
GTFS Parser for BMTC Bus Routes
Parses GTFS data from bmtc.zip and generates timetables for each stop.

Expects bmtc.zip to be available in the current path.
"""

import zipfile
import json
import csv
import os
import pandas as pd
from datetime import datetime, timedelta
import argparse
from pathlib import Path

class GTFSParser:
    def __init__(self, gtfs_zip_path, stops_geojson_path, output_dir="static/timetables"):
        self.gtfs_zip_path = gtfs_zip_path
        self.stops_geojson_path = stops_geojson_path
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # GTFS data containers
        self.stops = {}
        self.routes = {}
        self.trips = {}
        self.stop_times = {}
        self.calendar = {}
        self.calendar_dates = {}
        
        # ORR stops data
        self.orr_stops = {}
        
        # Target stops for filtering
        self.target_stop_names = [
            "B Narayanapura Ring Road",
            "Kalamandira",
            "Kadubisanahalli", 
            "Eco Space",
            "14th Main HSR Layout"
        ]
        
    def is_target_stop(self, stop_name):
        """Check if a stop name matches any of the target stop names"""
        for target_name in self.target_stop_names:
            if target_name.lower() in stop_name.lower():
                return True
        return False
        
    def load_orr_stops(self):
        """Load ORR stops from GeoJSON file"""
        print("Loading ORR stops from GeoJSON...")
        with open(self.stops_geojson_path, 'r', encoding='utf-8') as f:
            geojson_data = json.load(f)
            
        for feature in geojson_data['features']:
            props = feature['properties']
            stop_id = props['id']
            route_list = json.loads(props['route_list'])
            name = props['name']
            towards = props['towards']
            
            self.orr_stops[stop_id] = {
                'name': name,
                'route_list': route_list,
                'towards': towards,
                'coordinates': feature['geometry']['coordinates']
            }
            
        print(f"Loaded {len(self.orr_stops)} ORR stops")
        
    def find_routes_through_target_stops(self):
        """Find all routes that pass through at least one of the target stops"""
        target_routes = set()
        
        print("Finding routes that pass through target stops...")
        for stop_id, stop_info in self.orr_stops.items():
            if self.is_target_stop(stop_info['name']):
                print(f"  Target stop found: {stop_info['name']}")
                # Add all routes from this target stop
                for route in stop_info['route_list']:
                    target_routes.add(route)
                    
        print(f"Found {len(target_routes)} unique routes passing through target stops")
        return target_routes
        
    def load_gtfs_data(self):
        """Load GTFS data from zip file"""
        print("Loading GTFS data from zip file...")
        
        with zipfile.ZipFile(self.gtfs_zip_path, 'r') as zip_file:
            # Load stops
            with zip_file.open('stops.txt') as f:
                # Decode bytes to text and handle encoding issues
                text = f.read().decode('utf-8', errors='ignore')
                reader = csv.DictReader(text.splitlines())
                for row in reader:
                    self.stops[row['stop_id']] = row
                    
            # Load routes
            with zip_file.open('routes.txt') as f:
                text = f.read().decode('utf-8', errors='ignore')
                reader = csv.DictReader(text.splitlines())
                for row in reader:
                    self.routes[row['route_id']] = row
                    
            # Load trips
            with zip_file.open('trips.txt') as f:
                text = f.read().decode('utf-8', errors='ignore')
                reader = csv.DictReader(text.splitlines())
                for row in reader:
                    route_id = row['route_id']
                    if route_id not in self.trips:
                        self.trips[route_id] = []
                    self.trips[route_id].append(row)
                    
            # Load stop_times
            with zip_file.open('stop_times.txt') as f:
                text = f.read().decode('utf-8', errors='ignore')
                reader = csv.DictReader(text.splitlines())
                for row in reader:
                    stop_id = row['stop_id']
                    if stop_id not in self.stop_times:
                        self.stop_times[stop_id] = []
                    self.stop_times[stop_id].append(row)
                    
            # Load calendar
            try:
                with zip_file.open('calendar.txt') as f:
                    text = f.read().decode('utf-8', errors='ignore')
                    reader = csv.DictReader(text.splitlines())
                    for row in reader:
                        self.calendar[row['service_id']] = row
            except KeyError:
                print("No calendar.txt found, using calendar_dates.txt")
                
            # Load calendar_dates
            try:
                with zip_file.open('calendar_dates.txt') as f:
                    text = f.read().decode('utf-8', errors='ignore')
                    reader = csv.DictReader(text.splitlines())
                    for row in reader:
                        service_id = row['service_id']
                        if service_id not in self.calendar_dates:
                            self.calendar_dates[service_id] = []
                        self.calendar_dates[service_id].append(row)
            except KeyError:
                print("No calendar_dates.txt found")
                
        print(f"Loaded GTFS data: {len(self.stops)} stops, {len(self.routes)} routes, {len(self.trips)} trip groups")
        
    def find_matching_routes(self, orr_route_list, target_routes):
        """Find GTFS routes that match ORR route names and pass through target stops"""
        matching_routes = []
        
        for route_id, route_data in self.routes.items():
            route_short_name = route_data.get('route_short_name', '')
            route_long_name = route_data.get('route_long_name', '')
            
            # Check if any ORR route matches this GTFS route
            for orr_route in orr_route_list:
                if (orr_route == route_short_name or 
                    orr_route in route_long_name or
                    route_short_name in orr_route):
                    # Only include if this route passes through target stops
                    if orr_route in target_routes:
                        matching_routes.append(route_id)
                    break
                    
        return matching_routes
        
    def get_trip_times_for_stop(self, stop_id, route_ids):
        """Get all trip times for a specific stop and routes"""
        trip_times = []
        
        if stop_id not in self.stop_times:
            return trip_times
            
        for stop_time in self.stop_times[stop_id]:
            trip_id = stop_time['trip_id']
            
            # Find the trip and check if it belongs to our routes
            for route_id in route_ids:
                if route_id in self.trips:
                    for trip in self.trips[route_id]:
                        if trip['trip_id'] == trip_id:
                            # Get route information
                            route_info = self.routes.get(route_id, {})
                            
                            trip_times.append({
                                'trip_id': trip_id,
                                'route_id': route_id,
                                'route_short_name': route_info.get('route_short_name', ''),
                                'route_long_name': route_info.get('route_long_name', ''),
                                'arrival_time': stop_time['arrival_time'],
                                'departure_time': stop_time['departure_time'],
                                'stop_sequence': stop_time['stop_sequence'],
                                'service_id': trip['service_id']
                            })
                            break
                            
        return trip_times
        
    def is_service_active(self, service_id, date=None):
        """Check if a service is active on a given date"""
        if date is None:
            date = datetime.now().date()
            
        # Check calendar_dates first (exceptions)
        if service_id in self.calendar_dates:
            for calendar_date in self.calendar_dates[service_id]:
                exception_date = datetime.strptime(calendar_date['date'], '%Y%m%d').date()
                if exception_date == date:
                    return calendar_date['exception_type'] == '1'
                    
        # Check regular calendar
        if service_id in self.calendar:
            calendar_info = self.calendar[service_id]
            weekday = date.weekday()  # 0=Monday, 6=Sunday
            
            # Map weekday to GTFS day names
            day_names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
            day_name = day_names[weekday]
            
            # Check if service is active on this day
            if calendar_info.get(day_name) == '1':
                start_date = datetime.strptime(calendar_info['start_date'], '%Y%m%d').date()
                end_date = datetime.strptime(calendar_info['end_date'], '%Y%m%d').date()
                return start_date <= date <= end_date
                
        return False
        
    def generate_timetable_for_stop(self, stop_id, stop_info, target_routes):
        """Generate timetable CSV for a specific stop"""
        print(f"Generating timetable for stop {stop_id}: {stop_info['name']}")
        
        # Find matching GTFS routes that pass through target stops
        matching_routes = self.find_matching_routes(stop_info['route_list'], target_routes)
        
        if not matching_routes:
            print(f"No matching routes found for stop {stop_id} that pass through target stops")
            return
            
        # Get all trip times for this stop
        trip_times = self.get_trip_times_for_stop(stop_id, matching_routes)
        
        if not trip_times:
            print(f"No trip times found for stop {stop_id}")
            return
            
        # Filter for today's service
        today = datetime.now().date()
        active_trips = []
        
        for trip_time in trip_times:
            if self.is_service_active(trip_time['service_id'], today):
                active_trips.append(trip_time)
                
        if not active_trips:
            print(f"No active trips found for stop {stop_id} today")
            return
            
        # Sort by arrival time
        active_trips.sort(key=lambda x: x['arrival_time'])
        
        # Generate CSV data
        csv_data = []
        for trip in active_trips:
            # Parse time and format
            try:
                arrival_time = datetime.strptime(trip['arrival_time'], '%H:%M:%S').time()
                departure_time = datetime.strptime(trip['departure_time'], '%H:%M:%S').time()
                
                csv_data.append({
                    'stop_id': stop_id,
                    'route_name': trip['route_short_name'],
                    'time': arrival_time.strftime('%H:%M'),
                    'towards': stop_info['towards'],
                })
            except ValueError as e:
                print(f"Error parsing time for trip {trip['trip_id']}: {e}")
                continue
                
        # Write CSV file
        output_file = self.output_dir / f"{stop_id}-timetable.csv"
        
        with open(output_file, 'w', newline='', encoding='utf-8') as f:
            if csv_data:
                writer = csv.DictWriter(f, fieldnames=csv_data[0].keys())
                writer.writeheader()
                writer.writerows(csv_data)
                
        print(f"Generated timetable for {stop_id}: {len(csv_data)} trips")
        
    def generate_all_timetables(self, target_routes):
        """Generate timetables for all ORR stops"""
        print("Generating timetables for all ORR stops...")
        
        for stop_id, stop_info in self.orr_stops.items():
            try:
                self.generate_timetable_for_stop(stop_id, stop_info, target_routes)
            except Exception as e:
                print(f"Error generating timetable for stop {stop_id}: {e}")
                continue
                
        print("Timetable generation complete!")
        
    def generate_summary(self):
        """Generate a summary of all timetables"""
        summary_data = []
        
        for stop_id, stop_info in self.orr_stops.items():
            timetable_file = self.output_dir / f"{stop_id}-timetable.csv"
            
            if timetable_file.exists():
                with open(timetable_file, 'r', encoding='utf-8') as f:
                    reader = csv.DictReader(f)
                    trips = list(reader)
                    
                summary_data.append({
                    'stop_id': stop_id,
                    'stop_name': stop_info['name'],
                    'towards': stop_info['towards'],
                    'route_count': len(set(trip['route_name'] for trip in trips)),
                    'trip_count': len(trips)
                })
            else:
                summary_data.append({
                    'stop_id': stop_id,
                    'stop_name': stop_info['name'],
                    'towards': stop_info['towards'],
                    'route_count': 0,
                    'trip_count': 0,
                    'first_trip': 'N/A',
                    'last_trip': 'N/A'
                })
                
        # Write summary CSV
        summary_file = self.output_dir / "timetables-summary.csv"
        with open(summary_file, 'w', newline='', encoding='utf-8') as f:
            if summary_data:
                writer = csv.DictWriter(f, fieldnames=summary_data[0].keys())
                writer.writeheader()
                writer.writerows(summary_data)
                
        print(f"Generated summary: {summary_file}")
        
    def run(self):
        """Run the complete parsing process"""
        print("Starting GTFS parsing process...")
        
        # Load data
        self.load_orr_stops()
        self.load_gtfs_data()
        
        # Find routes that pass through target stops
        target_routes = self.find_routes_through_target_stops()
        
        # Generate timetables
        self.generate_all_timetables(target_routes)
        
        # Generate summary
        self.generate_summary()
        
        print("GTFS parsing complete!")

def main():
    parser = argparse.ArgumentParser(description='Parse GTFS data and generate timetables')
    parser.add_argument('--gtfs', default='static/bmtc.zip', help='Path to GTFS zip file')
    parser.add_argument('--stops', default='static/orr-stops.geojson', help='Path to ORR stops GeoJSON file')
    parser.add_argument('--output', default='static/timetables', help='Output directory for timetables')
    
    args = parser.parse_args()
    
    # Check if files exist
    if not os.path.exists(args.gtfs):
        print(f"Error: GTFS file not found: {args.gtfs}")
        return
        
    if not os.path.exists(args.stops):
        print(f"Error: Stops file not found: {args.stops}")
        return
        
    # Create parser and run
    parser_instance = GTFSParser(args.gtfs, args.stops, args.output)
    parser_instance.run()

if __name__ == "__main__":
    main()
