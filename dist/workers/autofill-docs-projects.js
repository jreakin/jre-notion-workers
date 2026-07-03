export async function executeAutofillDocsProjects(_input, _notion) {
    return {
        success: true,
        scanned: 0,
        filled: 0,
        skipped: 0,
        results: [],
        summary: "No-op: Docs DB has no outbound Project relation in this workspace. Add a Project relation to Docs to enable this worker.",
    };
}
