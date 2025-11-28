/**
 * Cloudflare Pages Function for BMTC Live Arrival Data at a Stop
 * Falls back to static timetable data if live data is not available
 *
 * Endpoint: /api/bmtc/stops?stopid=20568
 */

export async function onRequest(context) {
	const { request, env } = context;

	// Handle CORS preflight requests
	if (request.method === 'OPTIONS') {
		return handleCORS();
	}

	// Only allow GET requests
	if (request.method !== 'GET') {
		return new Response('Method not allowed', {
			status: 405,
			headers: getCORSHeaders()
		});
	}

	try {
		// Get stop ID from URL query parameter
		const url = new URL(request.url);
		const stopId = url.searchParams.get('stopid');

		if (!stopId) {
			return new Response(JSON.stringify({ error: 'stopid parameter is required' }), {
				status: 400,
				headers: {
					'Content-Type': 'application/json',
					...getCORSHeaders()
				}
			});
		}

		// First, load static data to get the list of allowed routes (Yellow Line or Purple Line only)
		const staticData = await loadStaticTimetable(stopId, request.url);
		const allowedRoutes = new Set(staticData.routes);

		// Try to fetch live data and filter by allowed routes
		let liveData = null;
		try {
			console.log('BMTC API Request for stop:', {
				stationid: parseInt(stopId),
				triptype: 1
			});

			const bmtcResponse = await fetch(
				'https://bmtcmobileapi.karnataka.gov.in/WebAPI/GetMobileTripsData',
				{
					method: 'POST',
					headers: {
						'User-Agent':
							'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
						Accept: 'application/json, text/plain, */*',
						'Content-Type': 'application/json',
						lan: 'en',
						deviceType: 'WEB'
					},
					body: JSON.stringify({
						stationid: parseInt(stopId),
						triptype: 1
					})
				}
			);

			if (bmtcResponse.ok) {
				const result = await bmtcResponse.json();
				console.log('BMTC API Response:', result);

				// Check if API returned success with data
				if (result.Issuccess && result.data && result.data.length > 0) {
					// Convert live data to the format expected by the frontend
					// Pass allowedRoutes to filter only routes from static data
					// Pass staticData.towards to use the direction from static data
					liveData = await convertBMTCToTimetableFormat(
						result.data,
						context,
						allowedRoutes,
						staticData.towards
					);
				}
			}
		} catch (liveError) {
			console.warn('Failed to fetch live data, falling back to static:', liveError);
		}

		// If live data is available and has trips, return it
		if (liveData && liveData.trips && liveData.trips.length > 0) {
			return new Response(JSON.stringify(liveData), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-cache, no-store, must-revalidate',
					Pragma: 'no-cache',
					Expires: '0',
					...getCORSHeaders()
				}
			});
		}

		// Fallback to static timetable data
		console.log(`Falling back to static timetable for stop ${stopId}`);
		return new Response(JSON.stringify(staticData), {
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-cache, no-store, must-revalidate',
				Pragma: 'no-cache',
				Expires: '0',
				...getCORSHeaders()
			}
		});
	} catch (error) {
		console.error('Stop API Function Error:', error);
		return new Response(
			JSON.stringify({
				error: 'Failed to fetch stop data',
				message: error.message
			}),
			{
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					...getCORSHeaders()
				}
			}
		);
	}
}

/**
 * Map destination to metro line name
 * @param {string} destination - Destination name from API or CSV
 * @returns {string} "Yellow Line" or "Purple Line"
 */
function mapDestinationToLine(destination) {
	if (!destination) return 'Unknown';

	// Normalize destination name for comparison
	const normalized = destination.trim();

	// KR Pura and related destinations map to Purple Line
	if (normalized === 'KR Pura' || normalized.includes('KR Pura')) {
		return 'Purple Line';
	}

	// Silk Board and related destinations map to Yellow Line
	if (normalized === 'Silk Board' || normalized.includes('Silk Board')) {
		return 'Yellow Line';
	}

	// Default fallback
	return 'Unknown';
}

/**
 * Parse BMTC date string in DD-MM-YYYY HH:MM:SS format to JavaScript Date
 * BMTC API returns dates in IST timezone
 * @param {string} dateString - Date string in format "DD-MM-YYYY HH:MM:SS"
 * @returns {Date} JavaScript Date object in UTC
 */
function parseBMTCDate(dateString) {
	// Expected format: "31-10-2025 14:30:00" (DD-MM-YYYY HH:MM:SS in IST)
	const parts = dateString.split(' ');
	const dateParts = parts[0].split('-');
	const timeParts = parts[1] ? parts[1].split(':') : ['0', '0', '0'];

	const day = parseInt(dateParts[0], 10);
	const month = parseInt(dateParts[1], 10) - 1; // JavaScript months are 0-indexed
	const year = parseInt(dateParts[2], 10);
	const hours = parseInt(timeParts[0], 10);
	const minutes = parseInt(timeParts[1], 10);
	const seconds = parseInt(timeParts[2], 10);

	// Create date in ISO format with IST timezone offset
	// Format: YYYY-MM-DDTHH:MM:SS+05:30
	const isoString = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}+05:30`;

	return new Date(isoString);
}

/**
 * Convert BMTC API response to timetable format expected by frontend
 * Format: { trips: [{ route_name, time, towards }], routes: [string], towards: string }
 * @param {Array} data - BMTC API response data
 * @param {Object} context - Request context
 * @param {Set} allowedRoutes - Set of allowed route names to filter by (from static data)
 * @param {string} staticTowards - The "towards" direction from static data (e.g., "Yellow Line" or "Purple Line")
 */
async function convertBMTCToTimetableFormat(
	data,
	context,
	allowedRoutes = null,
	staticTowards = null
) {
	const now = new Date();
	const trips = [];
	const routes = new Set();
	// Use the "towards" direction from static data if provided
	let towards = staticTowards || null;

	// Process each trip from BMTC API
	data.forEach((trip) => {
		const routeNo = trip.routeno;
		const destination = trip.tostationname;

		// Filter: only include routes that are in the static data (Yellow Line or Purple Line)
		if (allowedRoutes && !allowedRoutes.has(routeNo)) {
			return;
		}

		// Parse arrival time
		const arrivalTime = parseBMTCDate(trip.arrivaltime);
		const duration_ms = arrivalTime - now;

		// Skip if bus has already arrived or is too far in the future (90 minutes)
		if (duration_ms < 0 || duration_ms > 90 * 60 * 1000) {
			return;
		}

		// Extract time directly from the original string (format: "DD-MM-YYYY HH:MM:SS")
		// This avoids timezone conversion issues
		const timeMatch = trip.arrivaltime.match(/\s(\d{2}):(\d{2}):\d{2}/);
		let timeString;
		if (timeMatch) {
			// Use the time directly from the string (already in IST)
			timeString = `${timeMatch[1]}:${timeMatch[2]}`;
		} else {
			// Fallback: convert from Date object (IST offset already applied in parseBMTCDate)
			const utcHours = arrivalTime.getUTCHours();
			const utcMinutes = arrivalTime.getUTCMinutes();
			// Add 5 hours 30 minutes for IST offset
			let istHours = utcHours + 5;
			let istMinutes = utcMinutes + 30;
			// Handle minute overflow
			if (istMinutes >= 60) {
				istHours += 1;
				istMinutes -= 60;
			}
			// Handle hour overflow (24-hour format)
			if (istHours >= 24) {
				istHours -= 24;
			}
			timeString = `${String(istHours).padStart(2, '0')}:${String(istMinutes).padStart(2, '0')}`;
		}

		// Use the "towards" direction from static data if provided, otherwise map from destination
		const lineName = staticTowards || mapDestinationToLine(destination);

		// Set towards from the first trip if not already set from static data
		if (!towards) {
			towards = lineName;
		}

		trips.push({
			route_name: routeNo,
			time: timeString,
			towards: lineName
		});

		routes.add(routeNo);
	});

	// Sort trips by time
	trips.sort((a, b) => {
		const [aHours, aMinutes] = a.time.split(':').map(Number);
		const [bHours, bMinutes] = b.time.split(':').map(Number);
		const aTime = aHours * 60 + aMinutes;
		const bTime = bHours * 60 + bMinutes;
		return aTime - bTime;
	});

	// Use static data's "towards" if provided, otherwise use the mapped value
	// Ensure towards is a line name (Yellow Line or Purple Line)
	const finalTowards = staticTowards || (towards && towards !== 'Unknown' ? towards : 'Unknown');

	return {
		trips,
		routes: Array.from(routes),
		towards: finalTowards
	};
}

/**
 * Load static timetable data from CSV file
 */
async function loadStaticTimetable(stopId, requestUrl) {
	try {
		// Construct URL to static timetable file
		// In Cloudflare Pages, static files are served from the root
		const baseUrl = new URL(requestUrl);
		const timetableUrl = `${baseUrl.origin}/timetables/${stopId}-timetable.csv`;

		console.log(`Fetching static timetable from: ${timetableUrl}`);

		const response = await fetch(timetableUrl);

		if (!response.ok) {
			throw new Error(`Failed to fetch static timetable: ${response.status}`);
		}

		const csvText = await response.text();
		const lines = csvText.split('\n');

		const trips = [];
		const routes = new Set();
		let towards = null;

		// Skip header line (index 0)
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;

			const values = parseCSVLine(line);
			if (values.length >= 4) {
				const route_name = values[1];
				const time = values[2];
				const towards_direction = values[3];

				// Map destination to line name (Yellow Line or Purple Line)
				const lineName = mapDestinationToLine(towards_direction);

				trips.push({
					route_name,
					time,
					towards: lineName
				});

				routes.add(route_name);

				// Set towards from first trip
				if (!towards) {
					towards = lineName;
				}
			}
		}

		// Ensure towards is a line name (Yellow Line or Purple Line)
		const finalTowards = towards && towards !== 'Unknown' ? towards : 'Unknown';

		return {
			trips,
			routes: Array.from(routes),
			towards: finalTowards
		};
	} catch (error) {
		console.error(`Error loading static timetable for stop ${stopId}:`, error);
		// Return empty data structure
		return {
			trips: [],
			routes: [],
			towards: 'Unknown'
		};
	}
}

/**
 * Parse CSV line handling quoted values
 */
function parseCSVLine(line) {
	const result = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];

		if (char === '"') {
			inQuotes = !inQuotes;
		} else if (char === ',' && !inQuotes) {
			result.push(current.trim());
			current = '';
		} else {
			current += char;
		}
	}

	result.push(current.trim());
	return result;
}

/**
 * Get CORS headers
 */
function getCORSHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type'
	};
}

/**
 * Handle CORS preflight requests
 */
function handleCORS() {
	return new Response(null, {
		status: 204,
		headers: getCORSHeaders()
	});
}
