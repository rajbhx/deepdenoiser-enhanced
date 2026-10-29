import * as theme from "@/src/constants/theme";
import ErrorModal from "@/src/components/ErrorModal";
import { importToDocuments } from "@/src/scripts/denoiseCache";
import { claimSharedFile, finishSharedFile } from "@/src/scripts/shareClaim";
import { mediaKind } from "@/src/scripts/mediaSelection";
import { useRouter } from "expo-router";
import { useIncomingShare } from "expo-sharing";
import { Host, LoadingIndicator } from "@expo/ui/jetpack-compose";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

export default function ShareHandler() {
  const { resolvedSharedPayloads, isResolving, clearSharedPayloads, error: shareError } = useIncomingShare();
  const router = useRouter();

  const [error, setError] = useState<Error | null>(null);
  const [isErrorModalVisible, setIsErrorModalVisible] = useState(false);
  const [isCopying, setIsCopying] = useState(false);

  useEffect(() => {
    if (!isResolving) {
      if (resolvedSharedPayloads.length > 0) {
        const payload = resolvedSharedPayloads[0];
        // In expo-sharing SDK 55, payload has contentUri, originalName, contentType
        if (payload.contentUri) {
          const claimedUri = payload.contentUri;
          if (!claimSharedFile(claimedUri)) return;
          (async () => {
            let success = false;
            try {
              // Copy the shared file out of its content:// grant into app
              // documents BEFORE navigating:
              //  - content:// grants can be revoked when the source app dies;
              //  - process.tsx builds fs.File from the URI, which requires a
              //    stable file:// path.
              setIsCopying(true);
              const imported = await importToDocuments(
                payload.contentUri!,
                payload.originalName || "shared_file",
                payload.value,
              );
              setIsCopying(false);

              clearSharedPayloads();
              success = true;
              router.replace({
                pathname: "/processing/process",
                params: {
                  fileuri: encodeURIComponent(imported.uri),
                  filename: encodeURIComponent(payload.originalName || "shared_file"),
                  batch: encodeURIComponent(JSON.stringify([{
                    uri: imported.uri,
                    name: payload.originalName || "shared_file",
                    kind: mediaKind(payload.originalName || "shared_file", payload.contentMimeType ?? payload.mimeType ?? (payload.contentType === "video" ? "video/*" : undefined)),
                  }])),
                },
              });

            } catch (copyErr) {
              setIsCopying(false);
              const err =
                copyErr instanceof Error
                  ? copyErr
                  : new Error(String(copyErr));
              console.error("Failed to import shared file:", err);
              setError(err);
              setIsErrorModalVisible(true);
              clearSharedPayloads();
            } finally {
              finishSharedFile(claimedUri, success);
            }
          })();
        } else {
          console.warn("Shared payload has no contentUri");
          router.replace("/(tabs)");
        }
      } else if (shareError) {
        console.error("Error resolving shared payload:", shareError);
        // Defer state updates to avoid cascading renders inside effect
        const err = shareError instanceof Error ? shareError : new Error(String(shareError));
        setTimeout(() => {
          setError(err);
          setIsErrorModalVisible(true);
        }, 0);
      }
    }
  }, [resolvedSharedPayloads, isResolving, shareError, clearSharedPayloads, router]);

  return (
    <View style={[theme.Styles.container, styles.centered]}>
      <Host matchContents colorScheme="dark">
        <LoadingIndicator color={theme.COLORS.primary} />
      </Host>
      <Text style={styles.loadingText}>
        {isResolving
          ? "Preparing shared file..."
          : isCopying
            ? "Copying shared file..."
            : "Redirecting..."}
      </Text>
      {shareError && <Text style={styles.errorText}>Error: {shareError.message}</Text>}

      <ErrorModal
        visible={isErrorModalVisible}
        error={error}
        onClose={() => {
          setIsErrorModalVisible(false);
          router.replace("/(tabs)");
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  loadingText: {
    marginTop: 20,
    fontSize: theme.FONT_SIZE.body,
    color: theme.COLORS.text,
    textAlign: "center",
  },
  errorText: {
    marginTop: 10,
    fontSize: theme.FONT_SIZE.small,
    color: theme.COLORS.error,
    textAlign: "center",
  },
});
