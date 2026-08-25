import { ModuleRegistry, AllCommunityModule, themeQuartz } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

// Match the Value Creed look — shared by the Table Viewer and the
// Configure Components grids so every table in the app renders the same.
export const gridTheme = themeQuartz.withParams({
  accentColor: '#c05a1e',
  headerBackgroundColor: '#1f2a44',
  headerTextColor: '#ffffff',
  fontFamily: "'Poppins', system-ui, sans-serif",
  fontSize: 13,
  headerFontWeight: 600,
  borderRadius: 8,
  wrapperBorderRadius: 12,
});
