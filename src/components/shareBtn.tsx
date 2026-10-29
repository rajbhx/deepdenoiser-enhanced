import { trackAppEvent } from "@/src/scripts/analytics";
import * as theme from "@/src/constants/theme";
import Feather from "@expo/vector-icons/Feather";
import * as Sharing from "expo-sharing";
import React from "react";
import {
    Alert,
    TouchableOpacity
} from "react-native";

interface ShareBtnProps {
    uri: string;
    beforeShare?: () => void;
}
const ShareBtn: React.FC<ShareBtnProps> = ({ uri, beforeShare }) => {
    const handleShare = async () => {
        try {
            beforeShare?.();
            if (await Sharing.isAvailableAsync()) {
                await Sharing.shareAsync(uri);
                trackAppEvent("share_file");
            } else {
                Alert.alert("Sharing not available", "The sharing service is not available on this device.");
            }
        } catch (error) {
            console.error("Failed to share file:", error);
            Alert.alert("Share Failed", error instanceof Error ? error.message : "Could not share this file.");
        }
    };

    return <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Share file"
        style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}
        onPress={handleShare}
        activeOpacity={0.7}
    >
        <Feather name="share-2" size={24} color={theme.COLORS.primary} />
    </TouchableOpacity>

}
export default ShareBtn;