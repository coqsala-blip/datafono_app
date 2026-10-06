import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { Image, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getIssuerLayout, LOGO_SIZES, normalizeLogoSettings, offsetFromIssuerDrag, type DocumentIssuer, type LogoSettings as DocumentLogoSettings, type LogoOffset } from '../documents/logo-layout';
import { t, type AppLocale } from '../i18n';

type Props = {
  issuer: DocumentIssuer;
  locale: AppLocale;
  onChange: (settings: DocumentLogoSettings) => void;
};

export function LogoSettings({ issuer, locale, onChange }: Props) {
  const [isA4, setIsA4] = useState(false);
  const [pageWidth, setPageWidth] = useState(280);
  const [measured, setMeasured] = useState({ key: '', width: 0, height: 0 });
  const [dragOffset, setDragOffset] = useState<{ key: string; offset: LogoOffset } | null>(null);
  const settings = normalizeLogoSettings(issuer);
  const offsetKey = isA4 ? 'logoOffsetA4' : 'logoOffsetTicket';
  const layout = getIssuerLayout({ ...issuer, ...(dragOffset?.key === offsetKey ? { [offsetKey]: dragOffset.offset } : {}) }, isA4);
  const scale = pageWidth / layout.pageWidth;
  const measurementKey = JSON.stringify([offsetKey, pageWidth, settings.logoSize, issuer.name, issuer.nif, issuer.address, issuer.logoUri]);
  const blockWidth = Math.max(layout.width * scale, measured.key === measurementKey ? measured.width : 0);
  const blockHeight = Math.max(layout.height * scale, measured.key === measurementKey ? measured.height : 0);
  const availableX = Math.max(0, pageWidth - blockWidth);
  const availableY = Math.max(0, layout.pageHeight * scale - blockHeight);
  const left = layout.offset.x * availableX;
  const top = layout.offset.y * availableY;
  const latest = useRef({ offsetKey, onChange, left, top, pageWidth, pageHeight: layout.pageHeight * scale, blockWidth, blockHeight, measurementKey });
  latest.current = { offsetKey, onChange, left, top, pageWidth, pageHeight: layout.pageHeight * scale, blockWidth, blockHeight, measurementKey };
  const gesture = useRef<{ key: string; left: number; top: number; offset: LogoOffset } | null>(null);
  const [responder] = useState(() => {
    const move = (dx: number, dy: number) => {
      const current = latest.current;
      const start = gesture.current;
      if (!start || start.key !== current.offsetKey) return;
      const offset = offsetFromIssuerDrag(start.left + dx, start.top + dy, current.pageWidth, current.pageHeight, current.blockWidth, current.blockHeight);
      start.offset = offset;
      setDragOffset({ key: start.key, offset });
    };
    const finish = () => {
      const current = latest.current;
      const start = gesture.current;
      if (start && start.key === current.offsetKey) current.onChange({ [start.key]: start.offset });
      gesture.current = null;
      setDragOffset(null);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        const current = latest.current;
        gesture.current = { key: current.offsetKey, left: current.left, top: current.top, offset: offsetFromIssuerDrag(current.left, current.top, current.pageWidth, current.pageHeight, current.blockWidth, current.blockHeight) };
      },
      onPanResponderMove: (_, state) => move(state.dx, state.dy),
      onPanResponderRelease: (_, state) => { move(state.dx, state.dy); finish(); },
      onPanResponderTerminate: finish,
      onPanResponderTerminationRequest: () => false,
    });
  });
  const tr = (key: string) => t(locale, key);

  return (
    <View style={styles.root}>
      <Text style={styles.heading}>{tr('logo.size')}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={tr('logo.size')} style={styles.segments}>
        {LOGO_SIZES.map(size => (
          <Pressable key={size} accessibilityRole="radio" accessibilityLabel={tr(`logo.${size}`)} accessibilityState={{ checked: settings.logoSize === size }} onPress={() => onChange({ logoSize: size })} style={[styles.segment, settings.logoSize === size && styles.selected]}>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={styles.segmentLabel}>{tr(`logo.${size}`)}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.heading}><Ionicons name="move-outline" size={14} color="#0369a1" /> {tr('logo.preview')}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={tr('logo.preview')} style={styles.segments}>
        {[false, true].map(formatA4 => (
          <Pressable key={String(formatA4)} accessibilityRole="radio" accessibilityLabel={tr(formatA4 ? 'logo.invoice' : 'logo.ticket')} accessibilityState={{ checked: isA4 === formatA4 }} onPress={() => setIsA4(formatA4)} style={[styles.segment, isA4 === formatA4 && styles.selected]}>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={styles.segmentLabel}>{tr(formatA4 ? 'logo.invoice' : 'logo.ticket')}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView style={styles.previewStage} contentContainerStyle={styles.previewStageContent} nestedScrollEnabled>
        <View
          accessibilityLabel={tr('logo.preview')}
          style={[styles.previewPage, { width: isA4 ? 300 : 224 }]}
        >
          <View testID="issuer-page" style={{ minHeight: layout.pageHeight * scale }} onLayout={event => setPageWidth(event.nativeEvent.layout.width)}>
            <View style={{ paddingTop: top }}>
              <View
                testID="issuer-drag-block"
                accessibilityLabel={tr('logo.move')}
                style={{ width: layout.width * scale, marginLeft: left, alignItems: 'center' }}
                onLayout={event => setMeasured({ key: measurementKey, width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
                {...responder.panHandlers}
              >
                {issuer.logoUri && <Image source={{ uri: issuer.logoUri }} resizeMode="contain" style={{ width: layout.logoWidth * scale, height: layout.logoWidth * scale, marginBottom: 8 * scale }} />}
                <Text allowFontScaling={false} style={[styles.issuerText, { width: layout.width * scale, fontSize: layout.nameSize * scale, lineHeight: layout.nameLineHeight * scale, fontWeight: '700' }]}>{layout.nameLines.join('\n')}</Text>
                <Text allowFontScaling={false} style={[styles.issuerText, { width: layout.width * scale, fontSize: layout.detailSize * scale, lineHeight: layout.detailLineHeight * scale }]}>{layout.detailLines.join('\n')}</Text>
              </View>
            </View>
            <View testID="issuer-document-content">
              <View style={styles.previewDivider} />
              {[0, 1, 2, 3, 4, 5].map(line => (
                <View key={line} style={styles.previewLineRow}>
                  <View style={[styles.previewLine, { width: line % 2 ? '48%' : '65%' }]} />
                  <View style={[styles.previewLine, { width: '18%' }]} />
                </View>
              ))}
              <View style={styles.previewDivider} />
              <View style={[styles.previewLine, styles.totalLine]} />
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { marginTop: 12, gap: 8 },
  heading: { fontSize: 13, fontWeight: '600', color: '#334155', marginTop: 4 },
  selected: { backgroundColor: '#e0f2fe', borderColor: '#0369a1' },
  segments: { flexDirection: 'row', gap: 4 },
  segment: { flex: 1, minWidth: 0, height: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 4 },
  segmentLabel: { color: '#334155', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  previewStage: { height: 400, backgroundColor: '#f1f5f9' },
  previewStageContent: { alignItems: 'center', padding: 12 },
  previewPage: { maxWidth: '100%', padding: 12, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#fff' },
  issuerText: { fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', textAlign: 'center', letterSpacing: 0, includeFontPadding: false, color: '#0f172a', padding: 0 },
  previewDivider: { borderTopWidth: 1, borderStyle: 'dashed', borderColor: '#cbd5e1', marginVertical: 12 },
  previewLineRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  previewLine: { height: 4, backgroundColor: '#cbd5e1' },
  totalLine: { width: '35%', alignSelf: 'flex-end', height: 6, backgroundColor: '#64748b', marginBottom: 6 },
});