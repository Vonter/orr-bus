<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	let mapContainer: HTMLDivElement;
	let map: any; // Will be typed after dynamic import
	let maplibregl: any; // Will be set after dynamic import
	let userLocation: { lat: number; lng: number } | null = null;
	let nearestStop: {
		name: string;
		coordinates: number[];
		id: string;
		route_list?: string[];
		towards?: string;
	} | null = null;
	let stopDetails: {
		name: string;
		routes: string[];
		coordinates: number[];
		id: string;
		timetable?: any;
	} | null = null;
	let locationError: string | null = null;
	let showFallbackUI = false;
	let allStops: {
		name: string;
		coordinates: number[];
		id: string;
		route_list?: string[];
		towards?: string;
	}[] = [];
	let isKeyboardOpen = false;
	let initialViewportHeight = 0;
	let oppositeDirectionStops: {
		name: string;
		coordinates: number[];
		id: string;
		route_list?: string[];
		towards?: string;
	}[] = [];
	let currentStopIndex = 0;
	let refreshInterval: NodeJS.Timeout | null = null;
	let orrBounds: number[][] | null = null;
	let isLoadingLiveData = false;
	let loadingStopId: string | null = null;
	let isLoadingLocation = false;

	// Default to Eco Space stop if no location
	const defaultStop: {
		name: string;
		coordinates: number[];
		id: string;
		route_list?: string[];
		towards?: string;
	} = {
		name: 'Eco Space',
		coordinates: [77.63472, 12.91637],
		id: '20568'
	};

	onMount(async () => {
		// Detect if user is on mobile
		const isMobile = window.innerWidth < 768;

		// Store initial viewport height for keyboard detection
		initialViewportHeight = window.innerHeight;

		// Initialize keyboard detection for mobile
		if (isMobile) {
			setupKeyboardDetection();
		}

		// Dynamically import MapLibre GL to reduce initial bundle size
		const maplibreModule = await import('maplibre-gl');
		maplibregl = maplibreModule.default;

		// Dynamically import CSS
		await import('maplibre-gl/dist/maplibre-gl.css');

		// Initialize map
		map = new maplibregl.Map({
			container: mapContainer,
			style: '/tiles.json',
			center: [77.68, 12.97],
			zoom: isMobile ? 11 : 12
		});

		map.on('load', async () => {
			// Load critical data in parallel for faster initialization
			await Promise.all([
				loadMetroLines(),
				loadBusData(),
				loadBusIcon(),
				loadMetroStationIcon(),
				loadORRBounds()
			]);
			//await loadORRHighway();
			//await loadMetroStations();
			await getUserLocation();
		});

		// Handle missing images
		map.on('styleimagemissing', (e: any) => {
			if (e.id === 'bus-front') {
				console.log('Bus icon missing, attempting to reload...');
				loadBusIcon();
			} else if (e.id === 'metro-station') {
				console.log('Metro station icon missing, attempting to reload...');
				loadMetroStationIcon();
			}
		});

		// Add click event listener for map taps
		map.on('click', (e: any) => {
			const { lng, lat } = e.lngLat;
			findNearestStopToPoint(lat, lng);
		});

		// Add click event listener for bus stops
		map.on('click', 'all-stops', (e: any) => {
			if (e.features && e.features.length > 0) {
				const feature = e.features[0];
				const geometry = feature.geometry as any;
				const coordinates = geometry.coordinates.slice();
				const properties = feature.properties;

				const stop = {
					name: properties.name,
					coordinates: coordinates,
					id: properties.id,
					route_list: properties.route_list || [],
					towards: properties.towards
				};

				selectStop(stop);
			}
		});

		// Change cursor on hover over bus stops
		map.on('mouseenter', 'all-stops', () => {
			map.getCanvas().style.cursor = 'pointer';
		});

		map.on('mouseleave', 'all-stops', () => {
			map.getCanvas().style.cursor = '';
		});

		// Initialize timetable data storage
		(window as any).timetableData = {};
	});

	// Clean up auto-refresh interval when component is destroyed
	onDestroy(() => {
		stopAutoRefresh();
	});

	async function loadORRHighway() {
		try {
			const response = await fetch('/orr-orr.geojson');
			const orrData = await response.json();

			// Add ORR highway source
			map.addSource('orr-highway', {
				type: 'geojson',
				data: orrData
			});

			// Add ORR highway layer with distinctive styling
			map.addLayer({
				id: 'orr-highway',
				type: 'line',
				source: 'orr-highway',
				paint: {
					'line-color': '#606060', // Black color to make it stand out
					'line-width': 8,
					'line-opacity': 0.4
				}
			});
		} catch (error) {
			console.error('Error loading ORR highway:', error);
		}
	}

	async function loadMetroLines() {
		try {
			const response = await fetch('/metro.geojson');
			const metroData = await response.json();

			// Separate stations and lines
			const stations = {
				...metroData,
				features: metroData.features.filter((feature: any) => feature.geometry.type === 'Point')
			};

			const lines = {
				...metroData,
				features: metroData.features.filter(
					(feature: any) => feature.geometry.type === 'LineString'
				)
			};

			// Add metro lines
			map.addSource('metro-lines', {
				type: 'geojson',
				data: lines
			});

			map.addLayer({
				id: 'metro-lines',
				type: 'line',
				source: 'metro-lines',
				paint: {
					'line-color': ['get', 'line_color'],
					'line-width': 4,
					'line-opacity': 0.8
				}
			});
		} catch (error) {
			console.error('Error loading metro data:', error);
		}
	}

	async function loadBusData() {
		try {
			// Load bus stops data for finding nearest stop
			const stopsResponse = await fetch('/orr-stops.geojson');
			const stopsData = await stopsResponse.json();

			// Store stops data for later use
			allStops = stopsData.features.map((stop: any) => ({
				name: stop.properties.name,
				coordinates: stop.geometry.coordinates,
				id: stop.properties.id,
				route_list: stop.properties.route_list || [],
				towards: stop.properties.towards
			}));

			// Add source for all bus stops
			map.addSource('all-stops', {
				type: 'geojson',
				data: stopsData
			});

			// Add layer for all bus stops with smaller icons
			// Icon size scales with zoom to reduce clutter when zoomed out
			map.addLayer({
				id: 'all-stops',
				type: 'symbol',
				source: 'all-stops',
				layout: {
					'icon-image': 'bus-front',
					'icon-size': [
						'interpolate',
						['linear'],
						['zoom'],
						10,
						0.4, // Smaller at zoom 10
						13,
						0.5, // Medium at zoom 13
						15,
						0.6 // Full size at zoom 15+
					],
					'icon-allow-overlap': false,
					'icon-ignore-placement': false,
					'icon-padding': 2,
					'icon-optional': false
				}
			});

			// Add empty source for selected stop (will be populated when stop is selected)
			map.addSource('selected-stop', {
				type: 'geojson',
				data: {
					type: 'FeatureCollection',
					features: []
				}
			});

			// Add layer for selected stop with larger bus icon
			map.addLayer({
				id: 'selected-stop',
				type: 'symbol',
				source: 'selected-stop',
				layout: {
					'icon-image': 'bus-front',
					'icon-size': 1.2,
					'icon-allow-overlap': true,
					'icon-ignore-placement': true
				}
			});
		} catch (error) {
			console.error('Error loading bus data:', error);
		}
	}

	async function loadBusIcon() {
		try {
			// Load the bus-stop.svg from assets
			const response = await fetch('/assets/bus-stop.svg');
			const svgText = await response.text();

			// Convert SVG to data URL
			const svgDataUrl = 'data:image/svg+xml;base64,' + btoa(svgText);

			// Load the image
			const img = new Image();
			img.onload = () => {
				map.addImage('bus-front', img);
			};
			img.onerror = (error) => {
				console.error('Error loading bus icon:', error);
			};
			img.src = svgDataUrl;
		} catch (error) {
			console.error('Error loading bus icon:', error);
		}
	}

	async function loadMetroStationIcon() {
		try {
			// Load the metro-station.svg from assets
			const response = await fetch('/assets/metro-station.svg');
			const svgText = await response.text();

			// Convert SVG to data URL
			const svgDataUrl = 'data:image/svg+xml;base64,' + btoa(svgText);

			// Load the image
			const img = new Image();
			img.onload = () => {
				map.addImage('metro-station', img);
			};
			img.onerror = (error) => {
				console.error('Error loading metro station icon:', error);
			};
			img.src = svgDataUrl;
		} catch (error) {
			console.error('Error loading metro station icon:', error);
		}
	}

	async function loadMetroStations() {
		try {
			const response = await fetch('/orr-stations.geojson');
			const stationsData = await response.json();

			// Add metro stations source
			map.addSource('orr-stations', {
				type: 'geojson',
				data: stationsData
			});

			console.log(stationsData);

			// Add metro station icons
			map.addLayer({
				id: 'orr-stations-icons',
				type: 'symbol',
				source: 'orr-stations',
				layout: {
					'icon-image': 'metro-station',
					'icon-size': 1,
					'icon-allow-overlap': true,
					'icon-ignore-placement': true
				},
				paint: {
					'icon-color': ['get', 'colour']
				}
			});
		} catch (error) {
			console.error('Error loading ORR metro stations:', error);
		}
	}

	async function loadORRBounds() {
		try {
			const response = await fetch('/orr-bounds.geojson');
			const boundsData = await response.json();

			// Extract polygon coordinates from the first feature
			// The LineString forms a closed polygon (first and last coordinates are the same)
			if (boundsData.features && boundsData.features.length > 0) {
				const geometry = boundsData.features[0].geometry;
				if (geometry.type === 'LineString' && geometry.coordinates) {
					orrBounds = geometry.coordinates;
				}
			}
		} catch (error) {
			console.error('Error loading ORR bounds:', error);
		}
	}

	function isPointInPolygon(point: { lat: number; lng: number }, polygon: number[][]): boolean {
		if (!polygon || polygon.length < 3) return false;

		const x = point.lng;
		const y = point.lat;
		let inside = false;

		// Ray casting algorithm
		for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
			const xi = polygon[i][0];
			const yi = polygon[i][1];
			const xj = polygon[j][0];
			const yj = polygon[j][1];

			const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
			if (intersect) inside = !inside;
		}

		return inside;
	}

	/**
	 * Map destination to metro line name
	 * @param destination - Destination name from CSV (e.g., "KR Pura", "Silk Board")
	 * @returns "Yellow Line" or "Purple Line"
	 */
	function mapDestinationToLine(destination: string): string {
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

	async function loadTimetableForStop(stopId: string, stopName: string, towards: string) {
		try {
			// Check if already loaded
			if ((window as any).timetableData[stopId]) {
				return (window as any).timetableData[stopId];
			}

			console.log(`Loading timetable for stop ${stopId}: ${stopName}`);

			// Preload static CSV first for immediate display
			try {
				const stopResponse = await fetch(`/timetables/${stopId}-timetable.csv`);
				const stopCsvText = await stopResponse.text();
				const stopLines = stopCsvText.split('\n');

				const trips: any[] = [];
				const routes: string[] = [];
				let mappedTowards: string | null = null;

				for (let j = 1; j < stopLines.length; j++) {
					if (stopLines[j].trim()) {
						const stopValues = parseCSVLine(stopLines[j]);
						if (stopValues.length >= 4) {
							const route_name = stopValues[1];
							const time = stopValues[2];
							const towards_direction = stopValues[3];

							// Map destination to line name (Yellow Line or Purple Line)
							const lineName = mapDestinationToLine(towards_direction);

							trips.push({
								route_name,
								time,
								towards: lineName
							});

							if (!routes.includes(route_name)) {
								routes.push(route_name);
							}

							// Set towards from first trip
							if (!mappedTowards) {
								mappedTowards = lineName;
							}
						}
					}
				}

				// Use mapped line name instead of raw towards parameter
				const finalTowards = mappedTowards && mappedTowards !== 'Unknown' ? mappedTowards : towards;

				const timetableData = {
					name: stopName,
					trips,
					routes,
					towards: finalTowards
				};

				// Store in global cache
				(window as any).timetableData[stopId] = timetableData;
				console.log(`Loaded ${trips.length} trips for stop ${stopId} from static CSV`);

				return timetableData;
			} catch (staticError) {
				console.warn(`Could not load static timetable for stop ${stopId}:`, staticError);
			}

			// If static load failed, return empty data
			const emptyData = {
				name: stopName,
				trips: [],
				routes: [],
				towards
			};
			(window as any).timetableData[stopId] = emptyData;
			return emptyData;
		} catch (stopError) {
			console.warn(`Could not load timetable for stop ${stopId}:`, stopError);
			// Add empty entry to cache
			const emptyData = {
				name: stopName,
				trips: [],
				routes: [],
				towards
			};
			(window as any).timetableData[stopId] = emptyData;
			return emptyData;
		}
	}

	async function fetchLiveDataForStop(stopId: string, stopName: string, towards: string) {
		// Set loading state for this specific stop
		isLoadingLiveData = true;
		loadingStopId = stopId;
		try {
			console.log(`Fetching live data for stop ${stopId}: ${stopName}`);
			const apiResponse = await fetch(`/api/bmtc/stops?stopid=${stopId}`);
			if (apiResponse.ok) {
				const apiData = await apiResponse.json();
				const timetableData = {
					name: stopName,
					trips: apiData.trips || [],
					routes: apiData.routes || [],
					towards: apiData.towards || towards
				};

				// Update global cache
				(window as any).timetableData[stopId] = timetableData;
				console.log(
					`Loaded ${timetableData.trips.length} trips for stop ${stopId} from API (live data)`
				);

				// Update stopDetails if this is the currently selected stop and we're still loading for it
				if (stopDetails && stopDetails.id === stopId && loadingStopId === stopId) {
					stopDetails.timetable = {
						trips: timetableData.trips,
						routes: timetableData.routes,
						towards: timetableData.towards
					};
					// Trigger reactivity by reassigning
					stopDetails = { ...stopDetails };
				}

				return timetableData;
			}
		} catch (apiError) {
			console.warn(`API request failed for stop ${stopId}:`, apiError);
		} finally {
			// Clear loading state only if we're still loading for this stop
			if (loadingStopId === stopId) {
				isLoadingLiveData = false;
				loadingStopId = null;
			}
		}
		return null;
	}

	function parseCSVLine(line: string): string[] {
		const result: string[] = [];
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

	async function getUserLocation() {
		// Set loading state
		isLoadingLocation = true;

		if (navigator.geolocation) {
			navigator.geolocation.getCurrentPosition(
				(position) => {
					isLoadingLocation = false;
					userLocation = {
						lat: position.coords.latitude,
						lng: position.coords.longitude
					};

					// Check if location is within ORR bounds
					if (orrBounds && isPointInPolygon(userLocation, orrBounds)) {
						// Find nearest stop
						findNearestStop(userLocation);

						// Add user location marker
						map.addSource('user-location', {
							type: 'geojson',
							data: {
								type: 'Feature',
								properties: {},
								geometry: {
									type: 'Point',
									coordinates: [userLocation.lng, userLocation.lat]
								}
							}
						});

						map.addLayer({
							id: 'user-location',
							type: 'circle',
							source: 'user-location',
							paint: {
								'circle-radius': 6,
								'circle-color': '#57B9FF',
								'circle-stroke-width': 2,
								'circle-stroke-color': '#ffffff'
							}
						});
					} else {
						// Location is outside ORR bounds, show message to user
						locationError = 'Location outside ORR bounds';
						showFallbackUI = true;
					}
				},
				(error) => {
					isLoadingLocation = false;
					locationError = error.message;
					console.error('Location error:', error);
					// Show fallback UI for user to select stop
					showFallbackUI = true;
				}
			);
		} else {
			isLoadingLocation = false;
			locationError = 'Geolocation not supported';
			// Show fallback UI for user to select stop
			showFallbackUI = true;
		}
	}

	async function findNearestStop(userLocation: { lat: number; lng: number }) {
		try {
			// Use already loaded stops data if available, otherwise fetch
			let stopsData;
			if (allStops.length > 0) {
				// Use cached data
				stopsData = {
					features: allStops.map((stop) => ({
						geometry: { coordinates: stop.coordinates },
						properties: {
							name: stop.name,
							id: stop.id,
							route_list: stop.route_list,
							towards: stop.towards
						}
					}))
				};
			} else {
				// Load bus stops data to find nearest stop
				const response = await fetch('/orr-stops.geojson');
				stopsData = await response.json();
			}

			let nearestDistance = Infinity;
			let nearestStopData: {
				name: string;
				coordinates: number[];
				id: string;
				route_list?: string[];
				towards?: string;
			} = defaultStop;

			// Calculate distance to each stop
			stopsData.features.forEach((stop: any) => {
				const stopCoords = stop.geometry.coordinates;
				const distance = calculateDistance(
					userLocation.lat,
					userLocation.lng,
					stopCoords[1],
					stopCoords[0]
				);

				if (distance < nearestDistance) {
					nearestDistance = distance;
					nearestStopData = {
						name: stop.properties.name,
						coordinates: stopCoords,
						id: stop.properties.id,
						route_list: stop.properties.route_list || [],
						towards: stop.properties.towards
					};
				}
			});

			nearestStop = nearestStopData;
			showStopDetails(nearestStop);

			// Center map on nearest stop
			map.flyTo({
				center: [nearestStopData.coordinates[0], nearestStopData.coordinates[1]] as [
					number,
					number
				],
				zoom: 15
			});
		} catch (error) {
			console.error('Error finding nearest stop:', error);
			nearestStop = defaultStop;
			showStopDetails(defaultStop);
		}
	}

	async function showStopDetails(stop: {
		name: string;
		coordinates: number[];
		id: string;
		route_list?: string[];
		towards?: string;
	}) {
		// Reset loading state when switching stops
		isLoadingLiveData = false;
		loadingStopId = null;

		// Load static timetable data first for immediate display
		const timetableData = await loadTimetableForStop(stop.id, stop.name, stop.towards || 'Unknown');

		stopDetails = {
			name: stop.name,
			routes: stop.route_list || [],
			coordinates: stop.coordinates,
			id: stop.id,
			timetable: {
				trips: timetableData.trips,
				routes: timetableData.routes,
				towards: timetableData.towards
			}
		};

		// Update the map marker for the selected stop
		updateSelectedStopMarker(stop);

		// Find opposite direction stops with the same name
		findOppositeDirectionStops(stop);

		// Fetch live data in the background and update if available
		fetchLiveDataForStop(stop.id, stop.name, stop.towards || 'Unknown');

		// Start auto-refresh for this stop
		startAutoRefresh();
	}

	function updateSelectedStopMarker(stop: {
		name: string;
		coordinates: number[];
		id: string;
		route_list?: string[];
	}) {
		// Update the selected stop source with the new stop
		const source = map.getSource('selected-stop') as any;
		if (source) {
			source.setData({
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						properties: {
							name: stop.name,
							id: stop.id
						},
						geometry: {
							type: 'Point',
							coordinates: stop.coordinates
						}
					}
				]
			});
		}
	}

	function findOppositeDirectionStops(currentStop: {
		name: string;
		coordinates: number[];
		id: string;
		route_list?: string[];
	}) {
		// Find all stops with the same name but different IDs
		oppositeDirectionStops = allStops.filter(
			(stop) => stop.name === currentStop.name && stop.id !== currentStop.id
		);

		// Set current stop index to 0 (current stop is the first one)
		currentStopIndex = 0;
	}

	function toggleDirection() {
		if (oppositeDirectionStops.length > 0) {
			// Cycle through opposite direction stops
			currentStopIndex = (currentStopIndex + 1) % (oppositeDirectionStops.length + 1);

			let selectedStop: { name: string; coordinates: number[]; id: string; route_list?: string[] };

			if (currentStopIndex === 0) {
				// Show original stop
				selectedStop = nearestStop!;
			} else {
				// Show opposite direction stop
				selectedStop = oppositeDirectionStops[currentStopIndex - 1];
			}

			// Update the selected stop and show details (this will restart auto-refresh)
			nearestStop = selectedStop;
			showStopDetails(selectedStop);

			// Center map on the new stop
			map.flyTo({
				center: [selectedStop.coordinates[0], selectedStop.coordinates[1]] as [number, number],
				zoom: 15
			});
		}
	}

	function getNextTrips(trips: any[], maxTrips = 5) {
		if (!trips || trips.length === 0) return [];

		const now = new Date();
		const currentTime = now.getHours() * 60 + now.getMinutes();

		return trips
			.map((trip: any) => {
				const [hours, minutes] = trip.time.split(':').map(Number);
				const tripTime = hours * 60 + minutes;
				return {
					time: trip.time,
					route: trip.route_name,
					towards: trip.towards,
					minutes: tripTime - currentTime
				};
			})
			.filter((trip: { minutes: number }) => trip.minutes >= 0)
			.sort((a: { minutes: number }, b: { minutes: number }) => a.minutes - b.minutes)
			.slice(0, maxTrips);
	}

	function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
		const R = 6371; // Earth's radius in km
		const dLat = ((lat2 - lat1) * Math.PI) / 180;
		const dLon = ((lon2 - lon1) * Math.PI) / 180;
		const a =
			Math.sin(dLat / 2) * Math.sin(dLat / 2) +
			Math.cos((lat1 * Math.PI) / 180) *
				Math.cos((lat2 * Math.PI) / 180) *
				Math.sin(dLon / 2) *
				Math.sin(dLon / 2);
		const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
		return R * c;
	}

	function selectStop(stop: {
		name: string;
		coordinates: number[];
		id: string;
		route_list?: string[];
	}) {
		nearestStop = stop;
		showStopDetails(stop);
		showFallbackUI = false;

		// Center map on selected stop
		map.flyTo({
			center: [stop.coordinates[0], stop.coordinates[1]] as [number, number],
			zoom: 15
		});
	}

	function resetSelection() {
		nearestStop = null;
		stopDetails = null;
		showFallbackUI = true;
		isLoadingLiveData = false;
		loadingStopId = null;

		// Stop auto-refresh
		stopAutoRefresh();

		// Clear the selected stop marker
		const source = map.getSource('selected-stop') as any;
		if (source) {
			source.setData({
				type: 'FeatureCollection',
				features: []
			});
		}

		// Reset map view
		const isMobile = window.innerWidth < 768;
		map.flyTo({
			center: [77.68, 12.97],
			zoom: isMobile ? 11 : 12
		});
	}

	function startAutoRefresh() {
		// Clear any existing interval
		stopAutoRefresh();

		// Start new interval to refresh every 60 seconds
		refreshInterval = setInterval(async () => {
			if (nearestStop && stopDetails) {
				// Fetch live data (which will update stopDetails if available)
				await fetchLiveDataForStop(
					nearestStop.id,
					nearestStop.name,
					nearestStop.towards || 'Unknown'
				);
			}
		}, 60000); // 60 seconds
	}

	function stopAutoRefresh() {
		if (refreshInterval) {
			clearInterval(refreshInterval);
			refreshInterval = null;
		}
	}

	function findNearestStopToPoint(lat: number, lng: number) {
		let nearestDistance = Infinity;
		let nearestStopData = defaultStop;

		allStops.forEach((stop) => {
			const distance = calculateDistance(lat, lng, stop.coordinates[1], stop.coordinates[0]);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestStopData = stop;
			}
		});

		selectStop(nearestStopData);
	}

	function setupKeyboardDetection() {
		// Detect keyboard open/close by monitoring viewport height changes
		const handleResize = () => {
			const currentHeight = window.innerHeight;
			const heightDifference = initialViewportHeight - currentHeight;

			// Consider keyboard open if viewport height decreased by more than 150px
			// This threshold helps avoid false positives from browser UI changes
			const keyboardThreshold = 150;

			if (heightDifference > keyboardThreshold && !isKeyboardOpen) {
				isKeyboardOpen = true;
				// Add class to body for CSS targeting
				document.body.classList.add('keyboard-open');
			} else if (heightDifference <= keyboardThreshold && isKeyboardOpen) {
				isKeyboardOpen = false;
				document.body.classList.remove('keyboard-open');
			}
		};

		// Listen for resize events
		window.addEventListener('resize', handleResize);

		// Also listen for focus events on input elements as additional detection
		const handleInputFocus = () => {
			// Small delay to allow viewport to adjust
			setTimeout(() => {
				const currentHeight = window.innerHeight;
				const heightDifference = initialViewportHeight - currentHeight;
				if (heightDifference > 100) {
					isKeyboardOpen = true;
					document.body.classList.add('keyboard-open');
				}
			}, 100);
		};

		const handleInputBlur = () => {
			// Small delay to allow viewport to adjust
			setTimeout(() => {
				const currentHeight = window.innerHeight;
				const heightDifference = initialViewportHeight - currentHeight;
				if (heightDifference <= 100) {
					isKeyboardOpen = false;
					document.body.classList.remove('keyboard-open');
				}
			}, 100);
		};

		// Add event listeners to input elements
		document.addEventListener('focusin', (e) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
				handleInputFocus();
			}
		});

		document.addEventListener('focusout', (e) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
				handleInputBlur();
			}
		});
	}
</script>

<div class="min-h-screen bg-gray-50">
	<div class="flex h-screen flex-col md:flex-row">
		<!-- Map Container -->
		<div class="map-container relative h-2/5 flex-1 md:h-full">
			<div bind:this={mapContainer} class="h-full w-full"></div>
		</div>

		<!-- Sidebar -->
		<div
			class="mobile-bottom-bar h-3/5 w-full overflow-y-auto border-l border-gray-200 bg-white shadow-xl transition-transform duration-300 ease-in-out md:h-full md:w-80"
		>
			{#if isLoadingLocation}
				<div class="p-6 text-center">
					<div class="mb-4">
						<svg
							class="mx-auto mb-3 h-12 w-12 text-gray-400"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
							/>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
							/>
						</svg>
					</div>
					<h3 class="mb-2 text-lg font-medium text-gray-900">Select a location</h3>
					<p class="text-sm text-gray-600">Finding device location...</p>
				</div>
			{:else if showFallbackUI}
				<div class="p-6 text-center">
					<div class="mb-4">
						<svg
							class="mx-auto mb-3 h-12 w-12 text-gray-400"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
							/>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
							/>
						</svg>
					</div>
					<h3 class="mb-2 text-lg font-medium text-gray-900">Select a Location</h3>
					<p class="text-sm text-gray-600">
						{locationError === 'Location outside ORR bounds'
							? 'Device location is outside ORR. Please tap on the map to select a location near ORR.'
							: 'Tap on the map to select a location near ORR.'}
					</p>
				</div>
			{:else if nearestStop}
				<div class="sticky top-0 border-b border-gray-200 bg-white p-4">
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-3">
							<svg class="h-5 w-5 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
								<path
									d="M4 16c0 .88.39 1.67 1 2.22V20a1 1 0 001 1h1a1 1 0 001-1v-1h8v1a1 1 0 001 1h1a1 1 0 001-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"
								/>
							</svg>
							<div>
								<h2 class="text-sm font-semibold text-gray-900">{nearestStop.name}</h2>
							</div>
						</div>
						{#if oppositeDirectionStops.length > 0}
							<button
								on:click={toggleDirection}
								class="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 hover:bg-gray-200"
								title="Toggle Direction"
							>
								🔄 Direction
							</button>
						{/if}
					</div>
				</div>

				{#if stopDetails && stopDetails.timetable}
					<div class="p-4">
						{#if isLoadingLiveData && loadingStopId === stopDetails.id}
							<div
								class="mb-3 flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700"
							>
								<svg
									class="h-4 w-4 animate-spin"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
									/>
								</svg>
								<span>Updating live timings...</span>
							</div>
						{/if}
						<div class="mb-4">
							<div class="mb-3 flex items-center justify-between gap-4">
								<div class="text-left">
									<h3 class="text-sm font-medium text-gray-700">
										{#if stopDetails.timetable.towards === 'Yellow Line'}
											Towards Silk Board
										{:else if stopDetails.timetable.towards === 'Purple Line'}
											Towards KR Pura
										{:else}
											Towards {stopDetails.timetable.towards}
										{/if}
									</h3>
								</div>
								<div class="text-right">
									{#if stopDetails.timetable.towards === 'Purple Line'}
										<div
											class="flex items-center justify-end gap-1 rounded bg-purple-100 px-2 py-1 text-xs font-medium text-purple-800"
										>
											<svg
												class="h-3 w-3"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
												viewBox="0 0 24 24"
											>
												<path
													d="M8 16V8.5a.5.5 0 0 1 .9-.3l2.7 3.599a.5.5 0 0 0 .8 0l2.7-3.6a.5.5 0 0 1 .9.3V16"
												/>
												<rect x="3" y="3" width="18" height="18" rx="2" />
											</svg>
											<span>Purple Line</span>
										</div>
									{:else if stopDetails.timetable.towards === 'Yellow Line'}
										<div
											class="flex items-center justify-end gap-1 rounded bg-yellow-100 px-2 py-1 text-xs font-medium text-yellow-800"
										>
											<svg
												class="h-3 w-3"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
												viewBox="0 0 24 24"
											>
												<path
													d="M8 16V8.5a.5.5 0 0 1 .9-.3l2.7 3.599a.5.5 0 0 0 .8 0l2.7-3.6a.5.5 0 0 1 .9.3V16"
												/>
												<rect x="3" y="3" width="18" height="18" rx="2" />
											</svg>
											<span>Yellow Line</span>
										</div>
									{:else}
										<span class="rounded bg-gray-100 px-2 py-1 text-xs text-gray-500">
											Towards {stopDetails.timetable.towards || 'Unknown'}
										</span>
									{/if}
								</div>
							</div>

							{#if stopDetails.timetable.trips && stopDetails.timetable.trips.length > 0}
								<div class="space-y-2">
									{#each getNextTrips(stopDetails.timetable.trips, 20) as trip}
										<div
											class="flex items-center justify-between rounded-lg bg-gray-50 p-3 transition-colors hover:bg-gray-100"
										>
											<div class="flex items-center gap-3">
												<div class="font-monotext-lg font-bold text-gray-900">{trip.route}</div>
											</div>
											<div class="text-right">
												<div class="text-ml font-mono font-semibold text-gray-500">{trip.time}</div>
											</div>
										</div>
									{/each}
								</div>
							{:else}
								<div class="py-8 text-center">
									<svg
										class="mx-auto mb-3 h-12 w-12 text-gray-300"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="1.5"
											d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
										/>
									</svg>
									<p class="text-sm text-gray-500">No buses scheduled</p>
								</div>
							{/if}
						</div>
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	/* Mobile keyboard adjustment styles */
	@media (max-width: 767px) {
		.mobile-bottom-bar {
			transform: translateY(0);
		}

		/* When keyboard is open, move the bottom bar up */
		:global(body.keyboard-open) .mobile-bottom-bar {
			transform: translateY(-50vh);
		}

		/* Adjust the map container height when keyboard is open */
		:global(body.keyboard-open) .map-container {
			height: 50vh !important;
		}
	}

	/* Ensure smooth transitions */
	.mobile-bottom-bar {
		transition: transform 0.3s ease-in-out;
	}
</style>
