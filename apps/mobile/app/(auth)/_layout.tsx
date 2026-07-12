import { Redirect, Stack } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { LanguagePicker } from '../../components/LanguagePicker';

export default function AuthLayout() {
  const { user } = useAuth();
  const { tokens } = useAppearance();
  const insets = useSafeAreaInsets();
  if (user) return <Redirect href="/(tabs)/shows" />;
  return (
    <View style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: tokens.background } }} />
      <View style={{ position: 'absolute', top: insets.top + 6, right: 12, zIndex: 10 }} pointerEvents="box-none">
        <LanguagePicker />
      </View>
    </View>
  );
}
