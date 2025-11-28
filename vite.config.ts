import devtoolsJson from 'vite-plugin-devtools-json';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

// Plugin to remove console.log in production
function removeConsole(): Plugin {
	return {
		name: 'remove-console',
		enforce: 'post',
		transform(code, id) {
			// Only process in production and skip node_modules
			if (process.env.NODE_ENV === 'production' && !id.includes('node_modules')) {
				// Remove console statements more safely
				return {
					code: code.replace(/console\.(log|warn|info|debug)\([^)]*\);/g, ''),
					map: null
				};
			}
			return null;
		}
	};
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		// Only include devtools in development
		...(process.env.NODE_ENV === 'development' ? [devtoolsJson()] : []),
		// Remove console logs in production
		removeConsole()
	],
	build: {
		// Optimize chunk splitting
		rollupOptions: {
			output: {
				manualChunks: (id) => {
					// Separate node_modules into vendor chunk
					// Note: MapLibre GL is dynamically imported, so it won't be in the initial bundle
					if (id.includes('node_modules')) {
						return 'vendor';
					}
				},
				// Optimize asset file names for better caching
				assetFileNames: (assetInfo) => {
					const info = assetInfo.name?.split('.') || [];
					const ext = info[info.length - 1];
					if (/png|jpe?g|svg|gif|tiff|bmp|ico/i.test(ext)) {
						return `assets/images/[name]-[hash][extname]`;
					}
					if (/woff2?|eot|ttf|otf/i.test(ext)) {
						return `assets/fonts/[name]-[hash][extname]`;
					}
					return `assets/[name]-[hash][extname]`;
				},
				chunkFileNames: 'assets/js/[name]-[hash].js',
				entryFileNames: 'assets/js/[name]-[hash].js'
			}
		},
		// Enable minification (esbuild is faster, but terser provides better compression)
		// Using esbuild for better build speed, console removal handled by build plugin
		minify: 'esbuild',
		// Optimize source maps for production
		sourcemap: false,
		// Increase chunk size warning limit (this is a Vite build option, not Rollup)
		chunkSizeWarningLimit: 1000,
		// Enable CSS code splitting
		cssCodeSplit: true,
		// Optimize asset inlining threshold (smaller assets will be inlined)
		assetsInlineLimit: 4096
	},
	// Optimize dependencies
	optimizeDeps: {
		include: ['maplibre-gl']
	}
});
