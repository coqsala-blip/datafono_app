import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import { Image, PixelRatio, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { captureRef, releaseCapture } from 'react-native-view-shot';
import { buildImageFilename, copyImageForExport, getImageCaptureSize } from '../documents/image-export';
import { getLogoLayout, type LogoSettings } from '../documents/logo-layout';
import { formatCurrencyForLocale, t, type AppLocale } from '../i18n';

export type ImageShareDocument = Readonly<{
  ticketCode: string;
  type: 'COBRO' | 'DEVOLUCIÓN';
  documentType: string;
  amount: number;
  originalAmount?: number;
  relatedTicketCode?: string;
  subtotal: number;
  iva: number;
  ivaRateApplied: number;
  createdAt: string;
  issuer: Readonly<LogoSettings & { name: string; nif: string; address: string; logoUri?: string }>;
  client?: Readonly<{ name: string; nif: string; address: string }>;
  items?: readonly Readonly<{ id: string; description: string; price: string }>[];
  refundHistory?: readonly Readonly<{ amount: number; date: string }>[];
  publicUrl?: string;
}>;

export const snapshotImageDocument = (document: ImageShareDocument): ImageShareDocument => Object.freeze({
  ...document,
  issuer: Object.freeze({ ...document.issuer }),
  client: document.client ? Object.freeze({ ...document.client }) : undefined,
  items: document.items ? Object.freeze(document.items.map(item => Object.freeze({ ...item }))) : undefined,
  refundHistory: document.refundHistory ? Object.freeze(document.refundHistory.map(refund => Object.freeze({ ...refund }))) : undefined,
});

type Props = { document: ImageShareDocument; locale: AppLocale; qrUri: string | null; onClose: () => void };
type ImageStatus = 'loading' | 'loaded' | 'error';
const documentKeys: Record<string, string> = {
  'TICKET DE VENTA': 'document.sale', 'FACTURA SIMPLIFICADA': 'document.simplified',
  'FACTURA COMPLETA': 'document.complete', 'TICKET DE DEVOLUCIÓN': 'document.refund',
  'COMPRA/DEVOLUCIONES': 'document.purchaseRefunds', 'PRESUPUESTO': 'document.quote', 'FACTURA': 'document.invoice',
};
const alignments = { left: 'flex-start', center: 'center', right: 'flex-end' } as const;

export function DocumentImageShare({ document, locale, qrUri, onClose }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const geometry = useRef({ width: 0, height: 0, layoutWidth: 0, revision: 0 });
  const imageStates = useRef<Record<string, ImageStatus>>({});
  const decodedImages = useRef<Record<string, boolean>>({});
  const attemptRef = useRef(0);
  const [, setRevision] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { width: windowWidth } = useWindowDimensions();
  const isA4 = ['FACTURA COMPLETA', 'FACTURA', 'PRESUPUESTO'].includes(document.documentType);
  const pageWidth = Math.max(240, Math.min(isA4 ? 600 : 340, windowWidth - 24));
  const logo = getLogoLayout(document.issuer, isA4);
  const logoScale = (pageWidth - 32) / (isA4 ? 600 : 280);
  const logoSize = logo.width * logoScale;
  const requiredImages = [document.issuer.logoUri ? 'logo' : '', document.publicUrl && qrUri ? 'qr' : ''].filter(Boolean);
  const tr = (key: string) => t(locale, key);
  const money = (value: number) => formatCurrencyForLocale(locale, value);
  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(value));
  const title = tr(documentKeys[document.documentType] || 'workflow.type');
  const imageFailed = requiredImages.some(key => imageStates.current[key] === 'error');
  const imagesReady = requiredImages.every(key => imageStates.current[key] === 'loaded');
  const size = getImageCaptureSize(geometry.current.width, geometry.current.height, PixelRatio.get(), Platform.OS);
  const measured = geometry.current.width > 0 && geometry.current.height > 0;
  const tooLong = measured && !size;
  const ready = measured && !!size && imagesReady && Math.abs(geometry.current.layoutWidth - pageWidth) < 1 && Math.abs(geometry.current.width - pageWidth) < 1;
  const readyRef = useRef(false);
  readyRef.current = ready;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const updateImage = (key: string, status: ImageStatus, imageAttempt: number) => {
    if (!alive.current || imageAttempt !== attemptRef.current) return;
    imageStates.current[key] = status;
    readyRef.current = false;
    setRevision(value => value + 1);
  };
  const renderImage = (key: string, uri: string, width: number, height: number) => {
    return <Image key={`${key}-${attempt}`} source={{ uri }} resizeMode="contain" style={{ width, height, maxWidth: '100%' }}
      onLoad={() => { if (attempt === attemptRef.current) decodedImages.current[key] = true; }}
      onError={() => {
        if (attempt === attemptRef.current) decodedImages.current[key] = false;
        updateImage(key, 'error', attempt);
      }}
      onLoadEnd={() => updateImage(key, decodedImages.current[key] ? 'loaded' : 'error', attempt)} />;
  };
  const logoView = document.issuer.logoUri ? (
    <View style={[styles.logo, { alignItems: alignments[logo.alignment] }]}>
      {renderImage('logo', document.issuer.logoUri, logoSize, logo.maxHeight * logoScale)}
    </View>
  ) : null;
  const share = async () => {
    if (inFlight.current || !readyRef.current || !scrollRef.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    let rawUri: string | undefined;
    const startRevision = geometry.current.revision;
    try {
      if (!await Sharing.isAvailableAsync()) {
        if (alive.current) setError('imageShare.unavailable');
        return;
      }
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!alive.current || !readyRef.current || startRevision !== geometry.current.revision) return;
      const captureSize = getImageCaptureSize(geometry.current.width, geometry.current.height, PixelRatio.get(), Platform.OS);
      if (!captureSize) { setError('imageShare.tooLong'); return; }
      rawUri = await captureRef(scrollRef, { ...captureSize, snapshotContentContainer: true, format: 'png', result: 'tmpfile' });
      if (!alive.current || !readyRef.current || startRevision !== geometry.current.revision) return;
      const uri = await copyImageForExport(rawUri, buildImageFilename([title, document.ticketCode]));
      if (alive.current) await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: tr('imageShare.action') });
    } catch {
      if (alive.current) setError('imageShare.failed');
    } finally {
      if (rawUri) releaseCapture(rawUri);
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const retry = () => {
    imageStates.current = {};
    decodedImages.current = {};
    attemptRef.current += 1;
    readyRef.current = false;
    setError('');
    setAttempt(value => value + 1);
  };
  const line = (label: string, value: string, strong = false) => (
    <View style={styles.line}><Text style={[styles.label, strong && styles.bold]}>{label}</Text><Text style={[styles.value, strong && styles.bold]}>{value}</Text></View>
  );

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.heading}>{tr('imageShare.preview')}</Text>
      <ScrollView key="document" ref={scrollRef} collapsable={false} removeClippedSubviews={false}
        style={[styles.scroll, { width: pageWidth }]} contentContainerStyle={styles.paper}
        onLayout={event => {
          geometry.current.layoutWidth = event.nativeEvent.layout.width;
          geometry.current.revision += 1;
          readyRef.current = false;
          setRevision(value => value + 1);
        }}
        onContentSizeChange={(width, height) => {
          geometry.current.width = width;
          geometry.current.height = height;
          geometry.current.revision += 1;
          readyRef.current = false;
          setRevision(value => value + 1);
        }}>
        <View style={[styles.document, { minHeight: isA4 ? (pageWidth * 297 / 210) : 0 }]}>
          {logo.placement === 'top' && logoView}
          <Text style={styles.issuer}>{document.issuer.name}</Text>
          <Text style={styles.text}>{tr('workflow.taxId')}: {document.issuer.nif}</Text>
          <Text style={styles.text}>{document.issuer.address}</Text>
          <Text style={styles.title}>{title}</Text>
          {line(tr('workflow.reference'), document.ticketCode)}
          {line(tr('workflow.date'), date(document.createdAt))}
          {document.client && <View style={styles.section}>
            <Text style={styles.bold}>{tr('workflow.client')}</Text>
            <Text style={styles.text}>{document.client.name || tr('workflow.generalClient')}</Text>
            <Text style={styles.text}>{tr('workflow.taxId')}: {document.client.nif}</Text>
            <Text style={styles.text}>{document.client.address}</Text>
          </View>}
          {!!document.items?.length && <View style={styles.section}>
            <Text style={styles.bold}>{tr('ticket.items')}</Text>
            {document.items.map((item, index) => <View key={`${item.id}-${index}`}>{line(item.description, money(parseFloat(item.price.replace(',', '.')) || 0))}</View>)}
          </View>}
          {!!document.refundHistory?.length && <View style={styles.section}>
            <Text style={styles.bold}>{tr('document.purchaseRefunds')}</Text>
            {line(tr('ticket.original'), money(document.originalAmount ?? document.amount))}
            {document.refundHistory.map((refund, index) => <View key={`${refund.date}-${index}`}>
              {line(`${tr('ticket.refundLine').replace('{number}', String(index + 1))} (${date(refund.date)})`, `-${money(refund.amount)}`)}
            </View>)}
            {line(tr('ticket.balance'), money(document.amount), true)}
          </View>}
          <View style={styles.section}>
            {document.type === 'DEVOLUCIÓN' && document.relatedTicketCode && line(tr('ticket.originalReceipt'), document.relatedTicketCode)}
            {document.type === 'DEVOLUCIÓN' && document.originalAmount !== undefined && <>
              {line(tr('ticket.original'), money(document.originalAmount))}
              {line(tr('ticket.refunded'), money(document.amount))}
              {line(tr('ticket.balance'), money(document.originalAmount - document.amount))}
            </>}
            {line(tr('ticket.taxBase'), money(document.subtotal))}
            {line(`${tr('workflow.vat')} (${document.ivaRateApplied}%)`, money(document.iva))}
            {line(tr(document.type === 'DEVOLUCIÓN' ? 'ticket.refunded' : 'ticket.balance'), money(document.amount), true)}
          </View>
          {document.publicUrl && qrUri && <View style={styles.qr}>
            <Text style={styles.bold}>{tr('ticket.qr')}</Text>
            {renderImage('qr', qrUri, 140, 140)}
            <Text style={styles.text}>{tr('ticket.code')}: {document.ticketCode}</Text>
          </View>}
          {logo.placement === 'bottom' && logoView}
        </View>
      </ScrollView>
      <View style={styles.controls}>
        {(tooLong || imageFailed || error) && <Text accessibilityRole="alert" style={styles.error}>{tr(tooLong ? 'imageShare.tooLong' : imageFailed ? 'imageShare.imageFailed' : error)}</Text>}
        {imageFailed && <Pressable accessibilityRole="button" style={styles.button} onPress={retry} disabled={busy}>
          <Ionicons name="refresh-outline" size={20} color="#17252a" /><Text style={styles.buttonText}>{tr('ticket.retry')}</Text>
        </Pressable>}
        <Pressable accessibilityRole="button" style={[styles.button, styles.share, (!ready || busy) && styles.disabled]} disabled={!ready || busy} onPress={share}>
          <Ionicons name="share-outline" size={20} color="#fff" /><Text style={[styles.buttonText, styles.shareText]}>{tr(busy ? 'common.loading' : 'imageShare.action')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.button} onPress={() => { alive.current = false; onClose(); }}>
          <Ionicons name="close-outline" size={20} color="#17252a" /><Text style={styles.buttonText}>{tr('common.close')}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#e9eef0', alignItems: 'center' },
  heading: { fontSize: 18, fontWeight: '700', color: '#17252a', padding: 12 },
  scroll: { flex: 1, backgroundColor: '#fff' },
  paper: { backgroundColor: '#fff' },
  document: { padding: 16, backgroundColor: '#fff' },
  logo: { marginVertical: 12 },
  issuer: { fontSize: 17, fontWeight: '700', color: '#111' },
  title: { fontSize: 18, fontWeight: '700', color: '#111', marginVertical: 16 },
  text: { fontSize: 13, color: '#111', marginVertical: 2, flexShrink: 1 },
  bold: { fontSize: 13, fontWeight: '700', color: '#111' },
  section: { borderTopWidth: 1, borderColor: '#777', marginTop: 12, paddingTop: 12 },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginVertical: 4 },
  label: { flex: 1, fontSize: 13, color: '#111', flexShrink: 1 },
  value: { maxWidth: '48%', fontSize: 13, color: '#111', textAlign: 'right', flexShrink: 1 },
  qr: { alignItems: 'center', marginTop: 20, gap: 8 },
  controls: { width: '100%', maxWidth: 600, padding: 12, gap: 8 },
  button: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, borderRadius: 6, padding: 12, backgroundColor: '#fff' },
  buttonText: { fontSize: 14, color: '#17252a', fontWeight: '600', flexShrink: 1 },
  share: { backgroundColor: '#087f70' },
  shareText: { color: '#fff' },
  disabled: { opacity: 0.45 },
  error: { color: '#b42318', fontSize: 13 },
});