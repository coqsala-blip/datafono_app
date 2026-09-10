import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';

export default function AppTabs() {
  const scheme = useColorScheme();
  const safeScheme = scheme === 'dark' || scheme === 'light' ? scheme : 'light';
  const colors = Colors[safeScheme];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Pressable style={[styles.tab, { backgroundColor: colors.backgroundElement }]}>
        <Text style={[styles.tabText, { color: colors.text }]}>Home</Text>
      </Pressable>
      <Pressable style={[styles.tab, { backgroundColor: colors.backgroundElement }]}>
        <Text style={[styles.tabText, { color: colors.text }]}>Explore</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    padding: 12,
    gap: 8,
  },
  tab: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
