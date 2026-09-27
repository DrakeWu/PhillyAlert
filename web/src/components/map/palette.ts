// Map constants, kept out of MapView.tsx so that file only exports a component (fast refresh).

export type Metric = 'excess' | 'gain' | 'density';
export type Layers = { cells: boolean; flags: boolean; markers: boolean; r311: boolean; hoods: boolean };
export type MapHandle = { fitBounds: (b: [[number, number], [number, number]], maxZoom?: number) => void; fitCity: () => void };

export const R311_WINDOW = 14;
export const HEX_AREA_KM2 = (sizeM: number) => ((3 * Math.sqrt(3)) / 2) * (sizeM / 1000) ** 2;

// Palette as literal colors (MapLibre paint can't read CSS variables). Mirrors index.css.
export const PALETTE = {
  light: {
    red: ['#8f2a20', '#c63a2b', '#e0877a', '#efc1b8'], // strong -> weak
    blue: ['#c9d7ef', '#9db8e6', '#5b86cc', '#2a5db0'], // weak -> strong
    mid: '#ebe6da',
    seq: ['#e6e0d2', '#cfc6b1', '#a39a85', '#6f6857', '#3d3a33'],
    ink: '#16150f',
    paper: '#f4f1ea',
    loss: '#c63a2b',
    gain: '#2a5db0',
    base: { bg: '#f4f1ea', water: '#d5dcdb', park: '#e6e5d3', building: '#e4ddcd', landuse: '#efebe1' },
  },
  dark: {
    red: ['#f07a6c', '#d4503f', '#8c3c33', '#4d2824'],
    blue: ['#2a3a55', '#35507e', '#4f7cc4', '#8fb4ef'],
    mid: '#2c2a26',
    seq: ['#24221f', '#3a3730', '#5a554a', '#8a8374', '#c2bdb0'],
    ink: '#efebe1',
    paper: '#141412',
    loss: '#e45b4c',
    gain: '#6b9be6',
    base: { bg: '#141412', water: '#1a2124', park: '#181a15', building: '#1f1e1b', landuse: '#171715' },
  },
};
