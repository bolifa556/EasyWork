import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const workerPaths = [
  "node_modules/pdfjs-dist/build/pdf.worker.mjs",
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
];

const propertiesMarker = `        const properties = {
          type,
          name: baseFontName,
          loadedName: baseDict.loadedName,
          systemFontInfo: null,`;

const compositeProperties = `        const properties = {
          type,
          name: baseFontName,
          loadedName: baseDict.loadedName,
          systemFontInfo: null,
          composite,`;

const structuresMarker = `        if (!properties.isInternalFont && this.options.useSystemFonts) {
          properties.systemFontInfo = getFontSubstitution(this.systemFontCache, this.idFactory, this.options.standardFontDataUrl, baseFontName, standardFontName, type);
        }
        const newProperties = await this.extractDataStructures(dict, properties);`;

const compositeStructuresWithoutWidths = `        if (!properties.isInternalFont && this.options.useSystemFonts) {
          properties.systemFontInfo = getFontSubstitution(this.systemFontCache, this.idFactory, this.options.standardFontDataUrl, baseFontName, standardFontName, type);
        }
        if (composite) {
          const cidEncoding = baseDict.get("Encoding");
          if (cidEncoding instanceof Name) {
            properties.cidEncoding = cidEncoding.name;
          }
          properties.cMap = await CMapFactory.create({
            encoding: cidEncoding,
            fetchBuiltInCMap: this._fetchBuiltInCMapBound,
            useCMap: null
          });
          properties.vertical = properties.cMap.vertical;
        }
        const newProperties = await this.extractDataStructures(dict, properties);`;

const compositeStructures = `${compositeStructuresWithoutWidths}
        if (composite) {
          this.extractWidths(dict, descriptor, newProperties);
        }`;

for (const relativePath of workerPaths) {
  const filePath = path.resolve(relativePath);
  const source = await readFile(filePath, "utf8");
  if (source.includes(compositeProperties) && source.includes(compositeStructures)) continue;
  if (!source.includes(propertiesMarker) && !source.includes(compositeProperties)) {
    throw new Error(`pdf.js descriptor-less Type0 property markers changed in ${relativePath}`);
  }
  if (!source.includes(structuresMarker) && !source.includes(compositeStructuresWithoutWidths)) {
    throw new Error(`pdf.js descriptor-less Type0 recovery markers changed in ${relativePath}`);
  }
  let patched = source.replace(propertiesMarker, compositeProperties);
  patched = source.includes(structuresMarker)
    ? patched.replace(structuresMarker, compositeStructures)
    : patched.replace(compositeStructuresWithoutWidths, compositeStructures);
  await writeFile(filePath, patched, "utf8");
  console.log(`[easywork] Patched descriptor-less Type0 recovery in ${relativePath}`);
}
