// Curated plain-language knowledge base for C2PA validation status codes.
//
// The upstream machine-readable definitions live in c2pa-rs's
// validation_results.rs and in the C2PA Technical Specification's validation
// chapter. This module deliberately explains operationally useful meaning —
// especially the difference between integrity failures (the bytes or manifest
// changed), credential/trust failures (the signer cannot be confirmed), and
// informational time-stamp findings.

const SPEC_VALIDATION = 'C2PA Technical Specification — Validation, existing-manifest status codes';

function entry(title, severity, explanation, whatItMeans, commonCauses, specReference = SPEC_VALIDATION) {
    return { title, severity, explanation, what_it_means: whatItMeans, common_causes: commonCauses, spec_reference: specReference };
}

export const VALIDATION_CODES = {
    'claimSignature.validated': entry(
        'Claim signature validated',
        'info',
        'The cryptographic signature over the C2PA claim verified successfully.',
        'The claim has not been altered since it was signed. This is an integrity result, not by itself proof that the signer is trustworthy or that the depicted scene is real.',
        ['Normal result for a well-formed, intact signed manifest.']
    ),
    'claimSignature.mismatch': entry(
        'Claim signature does not match',
        'error',
        'The cryptographic signature over the C2PA claim failed validation.',
        'The claim or signature bytes changed after signing, or the signature was never correct. Treat the manifest as invalid.',
        [
            'Manifest or signature bytes were edited, corrupted, or re-serialized after signing.',
            'A transcoding or metadata-writing tool preserved part of the C2PA data but rewrote the wrong bytes.',
            'The asset is a tampered copy of a signed file.'
        ]
    ),
    'claimSignature.insideValidity': entry(
        'Signed inside credential validity',
        'info',
        'The signing certificate was within its validity period at the signing time.',
        'The signature was created while the signing credential was supposed to be valid.',
        ['Normal result for a correctly time-stamped or dated signature.']
    ),
    'claimSignature.outsideValidity': entry(
        'Signed outside credential validity',
        'error',
        'The claim signature was created outside the validity period of the signing credential.',
        'The signing-time evidence conflicts with the certificate validity window, so the signature cannot be relied on as a normal valid signature.',
        [
            'The certificate expired or was not yet valid at the claimed signing time.',
            'The signing time or time-stamp is incorrect or has been manipulated.',
            'The signer used a test or misconfigured certificate.'
        ]
    ),

    'signingCredential.trusted': entry(
        'Signing credential trusted',
        'info',
        'The signing credential chains to or is explicitly present in a trust list used by the validator.',
        'The signer is recognized by the selected trust configuration. This strengthens provenance attribution, but it still is not a statement that the image content is real.',
        ['The asset was signed by a product or organization on the C2PA trust list or interim trust list.']
    ),
    'signingCredential.untrusted': entry(
        'Signing credential not trusted',
        'warning',
        'The signing credential is not listed on the validator\'s trust list.',
        'The manifest can still be cryptographically valid, but the validator cannot confirm that the signer is a recognized trusted actor. This usually produces the valid_untrusted verdict rather than invalid.',
        [
            'The asset was signed with a self-signed, test, or development certificate.',
            'The signer is legitimate but has not been added to the selected trust list.',
            'The configured trust list is old or narrower than the signer ecosystem.'
        ]
    ),
    'signingCredential.expired': entry(
        'Signing credential expired',
        'error',
        'The signing credential has expired.',
        'The certificate can no longer provide normal present-day validity. A trusted time-stamp may still prove the signature was made while the certificate was valid; without one, the manifest cannot be relied on as valid.',
        [
            'The certificate lifetime ended after the asset was signed.',
            'The manifest lacks a trusted time-stamp establishing signing inside the validity window.',
            'The signing system continued using an expired certificate.'
        ]
    ),

    'timeStamp.validated': entry(
        'Time-stamp validated',
        'info',
        'The time-stamp credential is well-formed and its message imprint and validity are correct.',
        'The signed time evidence cryptographically matches the claim.',
        ['Normal result for a manifest carrying a valid RFC 3161-style time-stamp.']
    ),
    'timeStamp.trusted': entry(
        'Time-stamp trusted',
        'info',
        'The time-stamp credential is listed on the validator\'s time-stamp trust list.',
        'The validator recognizes the time-stamping authority, so the signing time can be trusted according to the selected trust configuration.',
        ['The signer used a time-stamping authority trusted by the validator.']
    ),
    'timeStamp.mismatch': entry(
        'Time-stamp does not match',
        'warning',
        'The time-stamp does not correspond to the contents of the claim.',
        'The time evidence is inconsistent with the claim. In c2pa-rs this is informational rather than automatically fatal: validation can continue as if no reliable time-stamp were present.',
        [
            'The claim was changed after the time-stamp token was created.',
            'The time-stamp token was copied from another manifest.',
            'The token is malformed or was embedded incorrectly.'
        ]
    ),

    'assertion.hashedURI.match': entry(
        'Assertion reference hash matches',
        'info',
        'The hash of a referenced assertion matches the hash declared by the claim.',
        'That assertion is intact and is the same data the signer referred to.',
        ['Normal result for an intact manifest.']
    ),
    'assertion.hashedURI.mismatch': entry(
        'Assertion reference hash mismatch',
        'error',
        'The hash of a referenced assertion does not match the hash declared by the claim.',
        'An assertion changed after signing, or the claim reference points at the wrong bytes. The manifest integrity is broken.',
        [
            'A metadata assertion was edited after signing.',
            'Manifest data was corrupted or selectively copied.',
            'A tool rewrote an assertion without resigning the claim.'
        ]
    ),
    'assertion.dataHash.match': entry(
        'Asset data hash matches',
        'info',
        'The hash of the covered asset byte range matches the data-hash assertion.',
        'The covered asset bytes are unchanged since signing.',
        ['Normal result for an intact asset.']
    ),
    'assertion.dataHash.mismatch': entry(
        'Asset data hash mismatch',
        'error',
        'The hash of the covered asset bytes does not match the data-hash assertion.',
        'The asset content changed after signing. This is the classic tampering signal: the provenance manifest no longer describes these exact bytes.',
        [
            'The image pixels or encoded image stream were modified after signing.',
            'The file was recompressed, transcoded, or rewritten without creating a new valid manifest.',
            'The manifest was copied onto a different asset.'
        ]
    ),
    'assertion.missing': entry(
        'Assertion missing',
        'error',
        'An assertion listed in the claim is missing from the manifest.',
        'The manifest is incomplete and cannot be validated as originally signed.',
        [
            'A metadata-editing tool removed a C2PA assertion.',
            'The manifest was truncated or corrupted.',
            'A redaction or migration process removed data without updating the claim correctly.'
        ]
    ),

    'ingredient.manifest.validated': entry(
        'Ingredient manifest validated',
        'info',
        'The hash of an ingredient\'s referenced C2PA manifest validated successfully.',
        'The referenced ingredient provenance is intact.',
        ['Normal result for a valid ingredient with embedded provenance.']
    ),
    'ingredient.unknownProvenance': entry(
        'Ingredient provenance unknown',
        'info',
        'The ingredient had no C2PA manifest.',
        'The ingredient can be listed as a source, but there is no signed provenance chain for it.',
        [
            'The source asset never had Content Credentials.',
            'Metadata was stripped before the ingredient was incorporated.',
            'The ingredient came from a system that does not write C2PA manifests.'
        ]
    ),
    'ingredient.claimSignature.validated': entry(
        'Ingredient claim signature validated',
        'info',
        'The claim signature in an ingredient\'s referenced manifest validated successfully.',
        'The ingredient\'s own claim is cryptographically intact.',
        ['Normal result for a valid signed ingredient.']
    ),
    'ingredient.hashedURI.mismatch': entry(
        'Ingredient reference hash mismatch',
        'error',
        'The hash of a referenced ingredient claim does not match the corresponding hashed URI in the referring claim.',
        'The ingredient provenance reference no longer points at the data that was originally signed.',
        [
            'An ingredient manifest was replaced or edited after incorporation.',
            'The ingredient assertion was copied incorrectly.',
            'Manifest data was corrupted.'
        ]
    ),
    'ingredient.manifest.missing': entry(
        'Ingredient manifest missing',
        'error',
        'The referenced ingredient C2PA manifest could not be found.',
        'The ingredient chain is incomplete, so the referenced provenance cannot be checked.',
        ['The ingredient metadata was removed or not embedded.', 'A remote ingredient manifest is unavailable.', 'The manifest store is corrupt.']
    ),
    'ingredient.manifest.mismatch': entry(
        'Ingredient manifest hash mismatch',
        'error',
        'The embedded ingredient manifest hash does not match the hash declared in the ingredient assertion.',
        'The ingredient provenance data changed after the referring claim was signed.',
        ['The ingredient manifest was edited or replaced.', 'The ingredient assertion references different bytes than were embedded.']
    ),
    'ingredient.claimSignature.missing': entry(
        'Ingredient claim signature missing',
        'error',
        'The claim signature referenced by an ingredient claim was not found.',
        'The ingredient provenance cannot be cryptographically verified.',
        ['The ingredient manifest is incomplete.', 'Its signature box was stripped or corrupted.']
    ),
    'ingredient.claimSignature.mismatch': entry(
        'Ingredient claim signature mismatch',
        'error',
        'The hash or signature validation for an ingredient\'s claim signature does not match the reference in the ingredient assertion.',
        'The ingredient signature is not the one the referring provenance chain expects.',
        ['The ingredient manifest or signature was altered.', 'The ingredient assertion references a different signed manifest.']
    ),

    'manifest.multipleParents': entry(
        'Manifest has multiple parents',
        'error',
        'The manifest has more than one ingredient whose relationship is parentOf.',
        'The provenance graph is structurally ambiguous: a C2PA manifest may describe only one parent relationship.',
        ['A composition or export tool wrote multiple parentOf ingredients.', 'Ingredient relationships were hand-edited or merged incorrectly.']
    ),
};

// Unknown or future codes are explanation requests, not failures: return a
// conservative generic info entry so agents can still reason over the raw code.
export function explainValidationCode(code) {
    const normalized = typeof code === 'string' ? code.trim() : '';
    const found = VALIDATION_CODES[normalized];
    if (found) return { code: normalized, ...found };
    return {
        code: normalized,
        title: 'Unknown validation code',
        severity: 'info',
        explanation: 'This validation code is not in the server\'s curated knowledge base.',
        what_it_means: 'Treat the raw validator explanation and surrounding validation state as authoritative. The code may be new, extension-specific, or uncommon.',
        common_causes: [
            'A newer c2pa-rs or C2PA specification version emitted a code this server has not curated yet.',
            'A vendor-specific or experimental extension emitted a nonstandard status code.'
        ],
    };
}
