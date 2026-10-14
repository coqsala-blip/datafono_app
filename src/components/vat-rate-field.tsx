import { StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';

type VatRateFieldProps = {
  value: string;
  onChangeText: (value: string) => void;
  label: string;
  placeholder?: string;
  style?: StyleProp<ViewStyle>;
  inputRef?: TextInputProps['ref'];
  onFocus?: TextInputProps['onFocus'];
  onBlur?: TextInputProps['onBlur'];
};

/** Un solo cuadro: número editable + sufijo fijo "IVA/TAX" (no se puede borrar). */
export function VatRateField({
  value,
  onChangeText,
  label,
  placeholder,
  style,
  inputRef,
  onFocus,
  onBlur,
}: VatRateFieldProps) {
  return (
    <View style={[styles.box, style]}>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={value}
        onChangeText={(text) => onChangeText(String(text || '').replace(/[^\d.,]/g, ''))}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
        keyboardType="numeric"
        onFocus={onFocus}
        onBlur={onBlur}
      />
      <Text style={styles.suffix} pointerEvents="none">{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: 10,
    backgroundColor: '#fff',
  },
  input: {
    flex: 1,
    minWidth: 48,
    paddingVertical: 8,
    fontSize: 13,
    color: '#0f172a',
  },
  suffix: {
    marginLeft: 8,
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
});
