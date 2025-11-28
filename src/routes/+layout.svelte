<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<!-- Preload critical assets for faster loading -->
	<link rel="preload" href="/assets/bus-stop.svg" as="image" type="image/svg+xml" />
	<link rel="preload" href="/assets/metro-station.svg" as="image" type="image/svg+xml" />
</svelte:head>

{@render children?.()}
