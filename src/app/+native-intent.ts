// Keep externally supplied route strings bounded before router query parsing.
// Share payloads live in the native queue and are not parsed from this path.
export const MAX_EXTERNAL_PATH_LENGTH = 16 * 1024;

export function redirectSystemPath({
    path,
    initial,
}: {
    path: string;
    initial: boolean;
}) {
    try {
        // Share data is obtained from our bounded native queue, not from the
        // redirect URL; map it directly without decoding arbitrary query text.
        if (typeof path === "string" && path.includes("expo-sharing")) {
            return "/share-handler";
        }
        // A malicious external deep link should not consume unbounded parser
        // work or prevent the app from opening.
        if (typeof path !== "string" || path.length > MAX_EXTERNAL_PATH_LENGTH) {
            return "/(tabs)";
        }
        return path;
    } catch {
        return "/(tabs)";
    }
}
