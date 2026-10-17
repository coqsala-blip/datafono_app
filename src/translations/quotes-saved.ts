import type { AppLocale } from '../i18n';

const rows: Record<string, readonly [string, string, string, string, string, string, string, string]> = {
  'quote.titleLabel': ['Nombre del presupuesto', 'Quote name', 'Nom du devis', 'Angebotsname', 'Nome del preventivo', 'Nome do orçamento', 'Offertenaam', 'Nazwa wyceny'],
  'quote.titlePlaceholder': ['Ej.: Instalación eléctrica — Juan — Santander', 'E.g. Electrical install — John — Madrid', 'Ex. : Installation électrique — Jean — Lyon', 'z. B. Elektroinstallation — Hans — Berlin', 'Es.: Impianto elettrico — Mario — Milano', 'Ex.: Instalação elétrica — João — Porto', 'Bijv. Elektra — Jan — Amsterdam', 'Np. Instalacja elektryczna — Jan — Kraków'],
  'quote.titleRequired': ['Pon un nombre al presupuesto para identificarlo.', 'Enter a quote name so you can find it later.', 'Donnez un nom au devis pour le retrouver.', 'Geben Sie einen Angebotsnamen zur Identifikation ein.', 'Inserisci un nome al preventivo per identificarlo.', 'Indique um nome ao orçamento para o identificar.', 'Geef de offerte een naam om hem terug te vinden.', 'Podaj nazwę wyceny, aby ją rozpoznać.'],
  'quote.save': ['Guardar presupuesto', 'Save quote', 'Enregistrer le devis', 'Angebot speichern', 'Salva preventivo', 'Guardar orçamento', 'Offerte opslaan', 'Zapisz wycenę'],
  'quote.saved': ['Presupuesto guardado.', 'Quote saved.', 'Devis enregistré.', 'Angebot gespeichert.', 'Preventivo salvato.', 'Orçamento guardado.', 'Offerte opgeslagen.', 'Wycena zapisana.'],
  'quote.savedList': ['Presupuestos guardados ({count})', 'Saved quotes ({count})', 'Devis enregistrés ({count})', 'Gespeicherte Angebote ({count})', 'Preventivi salvati ({count})', 'Orçamentos guardados ({count})', 'Opgeslagen offertes ({count})', 'Zapisane wyceny ({count})'],
  'quote.savedGuidance': ['Ábrelos para editarlos o conviértelos en factura cuando el cliente acepte.', 'Open them to edit, or convert to an invoice when the customer accepts.', 'Ouvrez-les pour les modifier ou convertissez-les en facture quand le client accepte.', 'Öffnen zum Bearbeiten oder in Rechnung umwandeln, wenn der Kunde annimmt.', 'Aprili per modificarli o convertili in fattura quando il cliente accetta.', 'Abra-os para editar ou converta em fatura quando o cliente aceitar.', 'Open om te bewerken of zet om naar factuur als de klant akkoord gaat.', 'Otwórz, aby edytować, lub zamień na fakturę, gdy klient zaakceptuje.'],
  'quote.open': ['Abrir', 'Open', 'Ouvrir', 'Öffnen', 'Apri', 'Abrir', 'Openen', 'Otwórz'],
  'quote.convert': ['Convertir en factura', 'Convert to invoice', 'Convertir en facture', 'In Rechnung umwandeln', 'Converti in fattura', 'Converter em fatura', 'Omzetten naar factuur', 'Zamień na fakturę'],
  'quote.converted': ['Presupuesto convertido en factura pendiente. Márcala como cobrada cuando cobres.', 'Quote converted to a pending invoice. Mark it paid when you collect.', 'Devis converti en facture en attente. Marquez-la payée quand vous encaissez.', 'Angebot in offene Rechnung umgewandelt. Als bezahlt markieren, wenn Sie kassieren.', 'Preventivo convertito in fattura in sospeso. Segnala come pagata quando incassi.', 'Orçamento convertido em fatura pendente. Marque como paga quando cobrar.', 'Offerte omgezet naar openstaande factuur. Markeer als betaald wanneer u int.', 'Wycena zamieniona na oczekującą fakturę. Oznacz jako opłaconą po pobraniu.'],
  'quote.deleteConfirm': ['¿Eliminar el presupuesto «{title}»?', 'Delete quote “{title}”?', 'Supprimer le devis « {title} » ?', 'Angebot „{title}“ löschen?', 'Eliminare il preventivo «{title}»?', 'Eliminar o orçamento «{title}»?', 'Offerte „{title}” verwijderen?', 'Usunąć wycenę „{title}”?'],
  'quote.loaded': ['Presupuesto cargado en el formulario.', 'Quote loaded into the form.', 'Devis chargé dans le formulaire.', 'Angebot in das Formular geladen.', 'Preventivo caricato nel modulo.', 'Orçamento carregado no formulário.', 'Offerte in het formulier geladen.', 'Wycena wczytana do formularza.'],
};

const localeIndex: Record<AppLocale, number> = { es: 0, en: 1, fr: 2, de: 3, it: 4, pt: 5, nl: 6, pl: 7 };

export const quotesSavedTranslations: Record<AppLocale, Record<string, string>> = {
  es: {}, en: {}, fr: {}, de: {}, it: {}, pt: {}, nl: {}, pl: {},
};

for (const [key, values] of Object.entries(rows)) {
  (Object.keys(localeIndex) as AppLocale[]).forEach((locale) => {
    quotesSavedTranslations[locale][key] = values[localeIndex[locale]];
  });
}
