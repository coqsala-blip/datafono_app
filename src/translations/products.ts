import type { AppLocale } from '../i18n';

const rows: Record<string, readonly [string, string, string, string, string, string, string, string]> = {
  'tab.products': ['Productos', 'Products', 'Produits', 'Produkte', 'Prodotti', 'Produtos', 'Producten', 'Produkty'],
  'products.title': ['Catálogo de productos', 'Product catalogue', 'Catalogue de produits', 'Produktkatalog', 'Catalogo prodotti', 'Catálogo de produtos', 'Productencatalogus', 'Katalog produktów'],
  'products.empty': ['Aún no hay productos. Pulsa + para añadir el primero.', 'No products yet. Tap + to add the first one.', 'Aucun produit. Appuyez sur + pour en ajouter un.', 'Noch keine Produkte. Tippen Sie auf +, um das erste hinzuzufügen.', 'Nessun prodotto. Tocca + per aggiungerne uno.', 'Ainda não há produtos. Toque + para adicionar o primeiro.', 'Nog geen producten. Tik op + om de eerste toe te voegen.', 'Brak produktów. Dotknij +, aby dodać pierwszy.'],
  'products.add': ['Añadir producto', 'Add product', 'Ajouter un produit', 'Produkt hinzufügen', 'Aggiungi prodotto', 'Adicionar produto', 'Product toevoegen', 'Dodaj produkt'],
  'products.name': ['Nombre del producto', 'Product name', 'Nom du produit', 'Produktname', 'Nome prodotto', 'Nome do produto', 'Productnaam', 'Nazwa produktu'],
  'products.price': ['Precio con IVA (€)', 'Price incl. VAT (€)', 'Prix TTC (€)', 'Preis inkl. MwSt. (€)', 'Prezzo IVA inclusa (€)', 'Preço com IVA (€)', 'Prijs incl. btw (€)', 'Cena z VAT (€)'],
  'products.photo': ['Foto del producto', 'Product photo', 'Photo du produit', 'Produktfoto', 'Foto prodotto', 'Foto do produto', 'Productfoto', 'Zdjęcie produktu'],
  'products.save': ['Guardar producto', 'Save product', 'Enregistrer le produit', 'Produkt speichern', 'Salva prodotto', 'Guardar produto', 'Product opslaan', 'Zapisz produkt'],
  'products.delete': ['Eliminar', 'Delete', 'Supprimer', 'Löschen', 'Elimina', 'Eliminar', 'Verwijderen', 'Usuń'],
  'products.quantity': ['¿Cuántas unidades?', 'How many units?', 'Combien d’unités ?', 'Wie viele Einheiten?', 'Quante unità?', 'Quantas unidades?', 'Hoeveel stuks?', 'Ile sztuk?'],
  'products.addToCart': ['Añadir', 'Add', 'Ajouter', 'Hinzufügen', 'Aggiungi', 'Adicionar', 'Toevoegen', 'Dodaj'],
  'products.cart': ['Selección actual', 'Current selection', 'Sélection actuelle', 'Aktuelle Auswahl', 'Selezione attuale', 'Seleção atual', 'Huidige selectie', 'Bieżący wybór'],
  'products.cartEmpty': ['Selecciona productos y cantidades.', 'Select products and quantities.', 'Sélectionnez des produits et quantités.', 'Produkte und Mengen wählen.', 'Seleziona prodotti e quantità.', 'Selecione produtos e quantidades.', 'Selecteer producten en aantallen.', 'Wybierz produkty i ilości.'],
  'products.total': ['Total (IVA incl.)', 'Total (incl. VAT)', 'Total (TTC)', 'Gesamt (inkl. MwSt.)', 'Totale (IVA incl.)', 'Total (com IVA)', 'Totaal (incl. btw)', 'Suma (z VAT)'],
  'products.sendTpv': ['Enviar total al TPV', 'Send total to POS', 'Envoyer le total à la caisse', 'Summe an Kasse senden', 'Invia totale al POS', 'Enviar total ao TPV', 'Totaal naar kassa sturen', 'Wyślij sumę do kasy'],
  'products.clearCart': ['Vaciar selección', 'Clear selection', 'Vider la sélection', 'Auswahl leeren', 'Svuota selezione', 'Limpar seleção', 'Selectie wissen', 'Wyczyść wybór'],
  'products.destTpv': ['TPV', 'POS', 'Caisse', 'Kasse', 'POS', 'TPV', 'Kassa', 'Kasa'],
  'products.destInvoice': ['Factura', 'Invoice', 'Facture', 'Rechnung', 'Fattura', 'Fatura', 'Factuur', 'Faktura'],
  'products.destQuote': ['Presupuesto', 'Quote', 'Devis', 'Angebot', 'Preventivo', 'Orçamento', 'Offerte', 'Wycena'],
  'products.sendInvoice': ['Añadir a factura', 'Add to invoice', 'Ajouter à la facture', 'Zur Rechnung hinzufügen', 'Aggiungi a fattura', 'Adicionar à fatura', 'Toevoegen aan factuur', 'Dodaj do faktury'],
  'products.sendQuote': ['Añadir a presupuesto', 'Add to quote', 'Ajouter au devis', 'Zum Angebot hinzufügen', 'Aggiungi a preventivo', 'Adicionar ao orçamento', 'Toevoegen aan offerte', 'Dodaj do wyceny'],
  'products.selectCatalog': ['Seleccionar del catálogo', 'Select from catalogue', 'Choisir dans le catalogue', 'Aus Katalog wählen', 'Scegli dal catalogo', 'Selecionar do catálogo', 'Kiezen uit catalogus', 'Wybierz z katalogu'],
  'products.pendingBanner': ['Selección del catálogo lista para cobrar', 'Catalogue selection ready to charge', 'Sélection catalogue prête à encaisser', 'Katalogauswahl bereit zum Kassieren', 'Selezione catalogo pronta per l’incasso', 'Seleção do catálogo pronta para cobrar', 'Catalogusselectie klaar om te innen', 'Wybór z katalogu gotowy do pobrania'],
  'products.chargeNow': ['Cobrar selección', 'Charge selection', 'Encaisser la sélection', 'Auswahl kassieren', 'Incassa selezione', 'Cobrar seleção', 'Selectie innen', 'Pobierz wybór'],
  'products.clearPending': ['Quitar selección', 'Clear selection', 'Retirer la sélection', 'Auswahl entfernen', 'Rimuovi selezione', 'Remover seleção', 'Selectie wissen', 'Usuń wybór'],
  'products.nameRequired': ['Indica el nombre del producto.', 'Enter the product name.', 'Indiquez le nom du produit.', 'Produktname eingeben.', 'Inserisci il nome del prodotto.', 'Indique o nome do produto.', 'Voer de productnaam in.', 'Podaj nazwę produktu.'],
  'products.priceRequired': ['Indica un precio válido mayor que 0.', 'Enter a valid price greater than 0.', 'Indiquez un prix valide supérieur à 0.', 'Gültigen Preis größer als 0 eingeben.', 'Inserisci un prezzo valido maggiore di 0.', 'Indique um preço válido maior que 0.', 'Voer een geldige prijs groter dan 0 in.', 'Podaj prawidłową cenę większą od 0.'],
  'products.addedToQuote': ['Productos añadidos al presupuesto.', 'Products added to the quote.', 'Produits ajoutés au devis.', 'Produkte zum Angebot hinzugefügt.', 'Prodotti aggiunti al preventivo.', 'Produtos adicionados ao orçamento.', 'Producten toegevoegd aan de offerte.', 'Produkty dodane do wyceny.'],
  'products.addedToInvoice': ['Productos añadidos a la factura.', 'Products added to the invoice.', 'Produits ajoutés à la facture.', 'Produkte zur Rechnung hinzugefügt.', 'Prodotti aggiunti alla fattura.', 'Produtos adicionados à fatura.', 'Producten toegevoegd aan de factuur.', 'Produkty dodane do faktury.'],
  'products.sentToTpv': ['Total enviado al TPV. Ya puedes cobrar.', 'Total sent to POS. You can charge now.', 'Total envoyé à la caisse. Vous pouvez encaisser.', 'Summe an die Kasse gesendet. Sie können jetzt kassieren.', 'Totale inviato al POS. Puoi incassare.', 'Total enviado ao TPV. Já pode cobrar.', 'Totaal naar de kassa gestuurd. U kunt nu innen.', 'Suma wysłana do kasy. Możesz pobrać płatność.'],
  'products.cloudSyncFailed': [
    'El producto se guardó en este móvil, pero no se pudo sincronizar con la nube. Comprueba la conexión e inténtalo de nuevo (o tira hacia abajo en Productos). Si el fallo continúa, falta crear la tabla catalog_products en Supabase.',
    'The product was saved on this phone, but cloud sync failed. Check your connection and try again (or pull down on Products). If it keeps failing, the catalog_products table may be missing in Supabase.',
    'Le produit est enregistré sur ce téléphone, mais la synchronisation cloud a échoué. Vérifiez la connexion et réessayez (ou tirez vers le bas dans Produits). Si cela continue, la table catalog_products manque peut-être dans Supabase.',
    'Das Produkt wurde auf diesem Handy gespeichert, die Cloud-Synchronisation ist jedoch fehlgeschlagen. Prüfen Sie die Verbindung und versuchen Sie es erneut (oder ziehen Sie bei Produkte nach unten). Wenn es weiter fehlschlägt, fehlt möglicherweise die Tabelle catalog_products in Supabase.',
    'Il prodotto è salvato su questo telefono, ma la sincronizzazione cloud non è riuscita. Controlla la connessione e riprova (o scorri verso il basso in Prodotti). Se continua, potrebbe mancare la tabella catalog_products in Supabase.',
    'O produto foi guardado neste telemóvel, mas a sincronização na nuvem falhou. Verifique a ligação e tente de novo (ou puxe para baixo em Produtos). Se continuar a falhar, pode faltar a tabela catalog_products no Supabase.',
    'Het product is op deze telefoon opgeslagen, maar cloudsynchronisatie is mislukt. Controleer de verbinding en probeer opnieuw (of trek omlaag bij Producten). Als het blijft mislukken, ontbreekt mogelijk de tabel catalog_products in Supabase.',
    'Produkt zapisano na tym telefonie, ale synchronizacja z chmurą nie powiodła się. Sprawdź połączenie i spróbuj ponownie (lub pociągnij w dół w Produktach). Jeśli nadal nie działa, w Supabase może brakować tabeli catalog_products.',
  ],
};

const localeIndex: Record<AppLocale, number> = { es: 0, en: 1, fr: 2, de: 3, it: 4, pt: 5, nl: 6, pl: 7 };

export const productTranslations: Record<AppLocale, Record<string, string>> = {
  es: {}, en: {}, fr: {}, de: {}, it: {}, pt: {}, nl: {}, pl: {},
};

for (const [key, values] of Object.entries(rows)) {
  (Object.keys(localeIndex) as AppLocale[]).forEach((locale) => {
    productTranslations[locale][key] = values[localeIndex[locale]];
  });
}
