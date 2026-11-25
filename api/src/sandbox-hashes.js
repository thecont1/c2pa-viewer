// sha256 of every fixtures/*.jpg — the sandbox corpus for c2pa_test_ keys.
// Test keys may ONLY verify assets whose bytes hash to one of these values.
//
// Regenerate when the fixture corpus changes:
//   bun -e 'import {readdirSync,readFileSync} from "node:fs";
//     import {createHash} from "node:crypto";
//     for (const f of readdirSync("fixtures").filter(f=>f.endsWith(".jpg")).sort())
//       console.log(createHash("sha256").update(readFileSync(`fixtures/${f}`)).digest("hex"), f)'
// (generated 2026-11-25 — corpus: A, C, C_with_CAWG_data, DSCF9243, cloud, gps, tampered)

export const SANDBOX_SHA256 = new Set([
    'f999fd78bfe8a83c96e468a078830ba94485bc1bc6fd086fb94a43bd29dd0f23', // A.jpg
    '4cbac1af485155f878d12a610da851c2938f2ce886189c61d9da7a0a43bd00b5', // C.jpg
    'fa0b257c863cb5b367135a017813ce0c1fbfc690a03e94acdd047c25c2d1ed46', // C_with_CAWG_data.jpg
    '858bee16e500c6ad4d048391e53ab57a6e5622f0affab5a83360176334ecaebf', // DSCF9243.jpg
    'e6ad9f51be5bb83f137322a3f260b5881738e3528aee208727e75b6daaba6092', // cloud.jpg
    'c1a9e63e4a590eb01546374aaf9049aded362cf7ab39473368fe8f0801a25856', // gps.jpg
    '685f300547ac0e06ac7a9967849edde02a58ec51fc2125b39dbbf0f4b611fbd4', // tampered.jpg
]);
