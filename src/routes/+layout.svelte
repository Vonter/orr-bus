<script lang="ts">
	import '../app.css';
	import Analytics from '../components/Analytics.svelte';
	import SEO from '../components/SEO.svelte';

	const hasAnalytics = Boolean(import.meta.env['VITE_GOOGLE_ANALYTICS_ID']);
	let { children } = $props();
</script>

<SEO />

{#if hasAnalytics}
	<Analytics />
{/if}

{@render children?.()}
