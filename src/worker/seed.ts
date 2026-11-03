// Configuración inicial: la copia de lo que hoy está armado en HubSpot (portal 47666798).
// Los ids de pipelines y etapas son los mismos de HubSpot, así la migración no traduce nada.
// La migración (`scripts/migrate-hubspot.mjs`) vuelve a sincronizar opciones si cambian allá.

type Opt = string | [value: string, label: string];
type PropDef = [name: string, label: string, type: string, group?: string, options?: Opt[], extra?: Partial<PropFlags>];
interface PropFlags { system: boolean; read_only: boolean; in_create_form: boolean; required: boolean; description: string }

export const TEAMS: Array<[id: number, name: string]> = [
  [58079782, 'Corporate (Grandes Cuentas)'],
  [57132078, 'Formas Shop'],
  [57393663, 'NOESTRES'],
];

const SI_NO: Opt[] = [['true', 'Sí'], ['false', 'No']];

const LIFECYCLE: Opt[] = [
  ['subscriber', 'Listado de Empresas S/A'],
  ['lead', 'Prospect'],
  ['marketingqualifiedlead', 'Lead'],
  ['salesqualifiedlead', 'Lead Calificado'],
  ['evangelist', 'Se te cayó cotización'],
  ['opportunity', 'Activo cotización'],
  ['other', 'Se te cayó ventas'],
  ['customer', 'Activo ventas'],
];

const LEAD_STATUS: Opt[] = [
  ['NEW', 'Nuevo'], ['OPEN', 'Abierto'], ['IN_PROGRESS', 'En curso'], ['OPEN_DEAL', 'Negocio abierto'],
  ['UNQUALIFIED', 'No calificado'], ['ATTEMPTED_TO_CONTACT', 'Intento de contacto'], ['CONNECTED', 'Conectado'],
  ['BAD_TIMING', 'Mal momento'], ['Por re contactar', 'Por re contactar'], ['Clientes con objetivos', 'Clientes con objetivos'],
];

const CANAL: Opt[] = [
  'Evento/ Exposicion', ['Llamada entrante', 'Llamada'], ['Contacto por Whatsapp', 'Whatsapp'], ['Ejecutiva de cuentas', 'Referido'],
  ['Contacto por email', 'Email'], 'Linkedin', 'Formulario MetaAds', 'Formulario LinkedInAds', 'Consulta formas.ar',
  'Instagram DM', 'Facebook Messenger', 'WebChat', 'MercadoLibre',
];

const TIPO_ORIGEN: Opt[] = ['Pauta', 'Orgánico', 'Base propia', 'Referido', 'Prospección', 'Evento', 'Sin identificar'];

const PAUTA: Opt[] = ['Meta - Interacción (CTWA)', 'Meta - Conversión', 'Meta - Formulario', 'Google Ads - Search', 'LinkedIn Ads'];

// Las mismas opciones de HubSpot (las más usadas, en castellano), así nada que venga de HubSpot queda afuera.
const INDUSTRIAS: Opt[] = [
  ['ACCOUNTING', 'Contabilidad'], ['AIRLINES_AVIATION', 'Airlines/Aviation'], ['ALTERNATIVE_DISPUTE_RESOLUTION', 'Alternative Dispute Resolution'],
  ['ALTERNATIVE_MEDICINE', 'Alternative Medicine'], ['ANIMATION', 'Animation'], ['APPAREL_FASHION', 'Apparel & Fashion'],
  ['ARCHITECTURE_PLANNING', 'Architecture & Planning'], ['ARTS_AND_CRAFTS', 'Arts and Crafts'], ['AUTOMOTIVE', 'Automotriz'],
  ['AVIATION_AEROSPACE', 'Aviation & Aerospace'], ['BANKING', 'Bancos'], ['BIOTECHNOLOGY', 'Biotechnology'],
  ['BROADCAST_MEDIA', 'Broadcast Media'], ['BUILDING_MATERIALS', 'Materiales de construcción'], ['BUSINESS_SUPPLIES_AND_EQUIPMENT', 'Business Supplies and Equipment'],
  ['CAPITAL_MARKETS', 'Capital Markets'], ['CHEMICALS', 'Química'], ['CIVIC_SOCIAL_ORGANIZATION', 'Civic & Social Organization'],
  ['CIVIL_ENGINEERING', 'Civil Engineering'], ['COMMERCIAL_REAL_ESTATE', 'Commercial Real Estate'], ['COMPUTER_NETWORK_SECURITY', 'Computer & Network Security'],
  ['COMPUTER_GAMES', 'Computer Games'], ['COMPUTER_HARDWARE', 'Computer Hardware'], ['COMPUTER_NETWORKING', 'Computer Networking'],
  ['COMPUTER_SOFTWARE', 'Computer Software'], ['INTERNET', 'Internet'], ['CONSTRUCTION', 'Construcción'],
  ['CONSUMER_ELECTRONICS', 'Consumer Electronics'], ['CONSUMER_GOODS', 'Consumo masivo'], ['CONSUMER_SERVICES', 'Consumer Services'],
  ['COSMETICS', 'Cosmética'], ['DAIRY', 'Dairy'], ['DEFENSE_SPACE', 'Defense & Space'],
  ['DESIGN', 'Design'], ['EDUCATION_MANAGEMENT', 'Educación'], ['E_LEARNING', 'E-Learning'],
  ['ELECTRICAL_ELECTRONIC_MANUFACTURING', 'Electrical/Electronic Manufacturing'], ['ENTERTAINMENT', 'Entretenimiento'], ['ENVIRONMENTAL_SERVICES', 'Environmental Services'],
  ['EVENTS_SERVICES', 'Eventos'], ['EXECUTIVE_OFFICE', 'Executive Office'], ['FACILITIES_SERVICES', 'Facilities Services'],
  ['FARMING', 'Agro'], ['FINANCIAL_SERVICES', 'Servicios financieros'], ['FINE_ART', 'Fine Art'],
  ['FISHERY', 'Fishery'], ['FOOD_BEVERAGES', 'Alimentos y bebidas'], ['FOOD_PRODUCTION', 'Producción de alimentos'],
  ['FUND_RAISING', 'Fund-Raising'], ['FURNITURE', 'Furniture'], ['GAMBLING_CASINOS', 'Gambling & Casinos'],
  ['GLASS_CERAMICS_CONCRETE', 'Glass, Ceramics & Concrete'], ['GOVERNMENT_ADMINISTRATION', 'Gobierno'], ['GOVERNMENT_RELATIONS', 'Government Relations'],
  ['GRAPHIC_DESIGN', 'Graphic Design'], ['HEALTH_WELLNESS_AND_FITNESS', 'Salud y bienestar'], ['HIGHER_EDUCATION', 'Educación superior'],
  ['HOSPITAL_HEALTH_CARE', 'Salud'], ['HOSPITALITY', 'Hotelería'], ['HUMAN_RESOURCES', 'Recursos humanos'],
  ['IMPORT_AND_EXPORT', 'Importación y exportación'], ['INDIVIDUAL_FAMILY_SERVICES', 'Individual & Family Services'], ['INDUSTRIAL_AUTOMATION', 'Industrial Automation'],
  ['INFORMATION_SERVICES', 'Information Services'], ['INFORMATION_TECHNOLOGY_AND_SERVICES', 'Tecnología'], ['INSURANCE', 'Seguros'],
  ['INTERNATIONAL_AFFAIRS', 'International Affairs'], ['INTERNATIONAL_TRADE_AND_DEVELOPMENT', 'International Trade and Development'], ['INVESTMENT_BANKING', 'Investment Banking'],
  ['INVESTMENT_MANAGEMENT', 'Investment Management'], ['JUDICIARY', 'Judiciary'], ['LAW_ENFORCEMENT', 'Law Enforcement'],
  ['LAW_PRACTICE', 'Estudios jurídicos'], ['LEGAL_SERVICES', 'Legal Services'], ['LEGISLATIVE_OFFICE', 'Legislative Office'],
  ['LEISURE_TRAVEL_TOURISM', 'Leisure, Travel & Tourism'], ['LIBRARIES', 'Libraries'], ['LOGISTICS_AND_SUPPLY_CHAIN', 'Logística'],
  ['LUXURY_GOODS_JEWELRY', 'Luxury Goods & Jewelry'], ['MACHINERY', 'Maquinaria'], ['MANAGEMENT_CONSULTING', 'Consultoría'],
  ['MARITIME', 'Maritime'], ['MARKET_RESEARCH', 'Market Research'], ['MARKETING_AND_ADVERTISING', 'Marketing y publicidad'],
  ['MECHANICAL_OR_INDUSTRIAL_ENGINEERING', 'Mechanical or Industrial Engineering'], ['MEDIA_PRODUCTION', 'Media Production'], ['MEDICAL_DEVICES', 'Medical Devices'],
  ['MEDICAL_PRACTICE', 'Medical Practice'], ['MENTAL_HEALTH_CARE', 'Mental Health Care'], ['MILITARY', 'Military'],
  ['MINING_METALS', 'Minería y metales'], ['MOTION_PICTURES_AND_FILM', 'Motion Pictures and Film'], ['MUSEUMS_AND_INSTITUTIONS', 'Museums and Institutions'],
  ['MUSIC', 'Music'], ['NANOTECHNOLOGY', 'Nanotechnology'], ['NEWSPAPERS', 'Newspapers'],
  ['NON_PROFIT_ORGANIZATION_MANAGEMENT', 'Non-Profit Organization Management'], ['OIL_ENERGY', 'Petróleo y energía'], ['ONLINE_MEDIA', 'Online Media'],
  ['OUTSOURCING_OFFSHORING', 'Outsourcing/Offshoring'], ['PACKAGE_FREIGHT_DELIVERY', 'Package/Freight Delivery'], ['PACKAGING_AND_CONTAINERS', 'Packaging and Containers'],
  ['PAPER_FOREST_PRODUCTS', 'Paper & Forest Products'], ['PERFORMING_ARTS', 'Performing Arts'], ['PHARMACEUTICALS', 'Farmacéutica'],
  ['PHILANTHROPY', 'Philanthropy'], ['PHOTOGRAPHY', 'Photography'], ['PLASTICS', 'Plastics'],
  ['POLITICAL_ORGANIZATION', 'Political Organization'], ['PRIMARY_SECONDARY_EDUCATION', 'Primary/Secondary Education'], ['PRINTING', 'Imprenta'],
  ['PROFESSIONAL_TRAINING_COACHING', 'Professional Training & Coaching'], ['PROGRAM_DEVELOPMENT', 'Program Development'], ['PUBLIC_POLICY', 'Public Policy'],
  ['PUBLIC_RELATIONS_AND_COMMUNICATIONS', 'Public Relations and Communications'], ['PUBLIC_SAFETY', 'Public Safety'], ['PUBLISHING', 'Publishing'],
  ['RAILROAD_MANUFACTURE', 'Railroad Manufacture'], ['RANCHING', 'Ranching'], ['REAL_ESTATE', 'Inmobiliaria'],
  ['RECREATIONAL_FACILITIES_AND_SERVICES', 'Recreational Facilities and Services'], ['RELIGIOUS_INSTITUTIONS', 'Religious Institutions'], ['RENEWABLES_ENVIRONMENT', 'Renewables & Environment'],
  ['RESEARCH', 'Research'], ['RESTAURANTS', 'Restaurants'], ['RETAIL', 'Retail'],
  ['SECURITY_AND_INVESTIGATIONS', 'Security and Investigations'], ['SEMICONDUCTORS', 'Semiconductors'], ['SHIPBUILDING', 'Shipbuilding'],
  ['SPORTING_GOODS', 'Sporting Goods'], ['SPORTS', 'Deportes'], ['STAFFING_AND_RECRUITING', 'Staffing and Recruiting'],
  ['SUPERMARKETS', 'Supermercados'], ['TELECOMMUNICATIONS', 'Telecomunicaciones'], ['TEXTILES', 'Textil'],
  ['THINK_TANKS', 'Think Tanks'], ['TOBACCO', 'Tobacco'], ['TRANSLATION_AND_LOCALIZATION', 'Translation and Localization'],
  ['TRANSPORTATION_TRUCKING_RAILROAD', 'Transporte'], ['UTILITIES', 'Servicios públicos'], ['VENTURE_CAPITAL_PRIVATE_EQUITY', 'Venture Capital & Private Equity'],
  ['VETERINARY', 'Veterinary'], ['WAREHOUSING', 'Warehousing'], ['WHOLESALE', 'Mayorista'],
  ['WINE_AND_SPIRITS', 'Vinos y bebidas espirituosas'], ['WIRELESS', 'Wireless'], ['WRITING_AND_EDITING', 'Writing and Editing'],
  ['MOBILE_GAMES', 'Mobile Games'], ['OTHER', 'Otra'],
];

const CORE = { system: true };
const RO = { system: true, read_only: true };
const FORM = { in_create_form: true };

// Estados generales del pedido (los mueve ClickUp; la vendedora solo pasa de «Pedido confirmado» a «Listo para producción»).
// Conservan los ids de HubSpot que siguen; los estados de HubSpot que se juntan se traducen en la migración (ORDER_STAGE_ALIAS).
// En el CRM la etapa del pedido es un desplegable: el tablero de pedidos se arma con él.
export const ORDER_STAGES: Array<[string, string]> = [
  ['4b27b500-f031-4927-9811-68a0b525cbae', 'Pedido confirmado'],
  ['3725360f-519b-4b18-a593-494d60a29c9f', 'Listo para producción'],
  ['esperando_boceto', 'Esperando boceto o confirmación'],
  ['1237498994', 'En producción'],
  ['1237498996', 'Listo para entregar'],
  ['entregado_parcial', 'Entregado parcial'],
  ['1237498998', 'Entregado'],
  ['3c85a297-e9ce-400b-b42e-9f16853d69d6', 'Anulado'],
];
export const ORDER_STAGE_ALIAS: Record<string, string> = {
  '937ea84d-0a4f-4dcf-9028-3f9c2aafbf03': '4b27b500-f031-4927-9811-68a0b525cbae',
  'aa99e8d0-c1d5-4071-b915-d240bbb1aed9': 'esperando_boceto',
  '1250237623': '1237498994',
  '1237498995': '1237498996',
  '1237498997': '1237498996',
};
export const ORDER_PIPELINES: Array<[string, string]> = [['14a2e10e-5471-408a-906e-c51f3b04369e', 'Formas Shop - Pipeline de pedidos']];

export const PROPERTIES: Record<string, PropDef[]> = {
  contact: [
    ['firstname', 'Nombre', 'string', 'Información del contacto', [], { ...CORE, ...FORM }],
    ['lastname', 'Apellido', 'string', 'Información del contacto', [], { ...CORE, ...FORM }],
    ['email', 'Email', 'email', 'Información del contacto', [], { ...CORE, ...FORM }],
    ['phone', 'Teléfono', 'phone', 'Información del contacto', [], { ...CORE, ...FORM }],
    ['mobilephone', 'Celular', 'phone', 'Información del contacto', [], CORE],
    ['jobtitle', 'Cargo', 'string', 'Información del contacto', [], { ...CORE, ...FORM }],
    ['company', 'Nombre de la empresa (texto)', 'string', 'Información del contacto', [], CORE],
    ['owner_id', 'Propietario', 'owner', 'Información del contacto', [], { ...CORE, ...FORM }],
    ['lifecyclestage', 'Etapa del ciclo de vida', 'enum', 'Información del contacto', LIFECYCLE, { ...CORE, ...FORM }],
    ['hs_lead_status', 'Estado del lead', 'enum', 'Información del contacto', LEAD_STATUS, CORE],
    ['tipo_de_cliente', 'Tipo de cliente', 'enum', 'Información del contacto', ['Particular', 'Empresa', 'Agencia']],
    ['website', 'Sitio web', 'url', 'Información del contacto', [], CORE],
    ['linkedin_url', 'LinkedIn', 'url', 'Información del contacto'],
    ['city', 'Ciudad', 'string', 'Dirección', [], CORE],
    ['state', 'Provincia', 'string', 'Dirección', [], CORE],
    ['country', 'País', 'string', 'Dirección', [], CORE],
    ['address', 'Dirección', 'string', 'Dirección', [], CORE],
    ['zip', 'Código postal', 'string', 'Dirección', [], CORE],
    ['cuit', 'CUIT', 'string', 'Facturación'],
    ['razon_social', 'Razón social', 'string', 'Facturación'],
    ['codigo_finnegans_nuevo', 'Código Finnegans', 'string', 'Facturación'],
    ['codigo_finnegans', 'Código Finnegans viejo', 'string', 'Facturación'],
    ['origen_del_contacto', 'Canal de contacto', 'enum', 'Origen', CANAL],
    ['tipo_de_origen', 'Tipo de origen', 'enum', 'Origen', TIPO_ORIGEN],
    ['origen_de_la_conversacion', 'Origen de la conversación', 'enum', 'Origen', ['Darwin', ['Agente Humano', 'Humano directo']]],
    ['prospect_source', 'Plataforma de origen', 'string', 'Origen'],
    ['campaign_name', 'Tipo de adquisición / Campaña', 'string', 'Origen'],
    ['plataforma_de_pauta', 'Plataforma de pauta', 'enum', 'Origen', PAUTA],
    ['evento', 'Evento', 'enum', 'Origen', ['Día del niño', 'Día de la mujer', 'Fin de año']],
    ['event_name', 'Nombre del evento', 'string', 'Origen'],
    ['tamano___empresa', 'Tamaño de la empresa', 'enum', 'Calificación', ['Pequeñas (hasta 50 empleados)', 'Medianas (entre 51 y 150 empleados)', 'Grandes (+150 empleados)']],
    ['volumen_de_compra_estimado', 'Volumen de compra estimado', 'enum', 'Calificación', ['Pequeño', 'Mediano', 'Grande']],
    ['volumen_minimo', 'Volumen mínimo', 'number', 'Calificación'],
    ['volumen_minimo_de_compra', 'Monto mínimo de compra', 'currency', 'Calificación'],
    ['industry', 'Industria', 'string', 'Calificación'],
    ['estado_de_lead___outbound', 'Estado de lead outbound', 'enum', 'Outbound', ['Nuevo', 'Contactado', 'R1', 'R2', 'Oportunidad de negocio', 'Propuesta enviada', 'Alta de cliente']],
    ['outbound_lead_status', 'Outbound lead status', 'enum', 'Outbound', ['New', 'Delegate', 'Not interested', 'Not target', 'Interested', 'Scheduled meeting', 'meeting propost', 'Client']],
    ['sales_notes', 'Notas de venta', 'text', 'Outbound'],
    ['message', 'Mensaje', 'text', 'Outbound', [], CORE],
  ],
  company: [
    ['name', 'Nombre de la empresa', 'string', 'Información de la empresa', [], { ...CORE, ...FORM, required: true }],
    ['domain', 'Dominio', 'string', 'Información de la empresa', [], { ...CORE, ...FORM }],
    ['website', 'Sitio web', 'url', 'Información de la empresa', [], CORE],
    ['phone', 'Teléfono', 'phone', 'Información de la empresa', [], { ...CORE, ...FORM }],
    ['email', 'Email', 'email', 'Información de la empresa'],
    ['owner_id', 'Propietario', 'owner', 'Información de la empresa', [], { ...CORE, ...FORM }],
    ['lifecyclestage', 'Etapa del ciclo de vida', 'enum', 'Información de la empresa', LIFECYCLE, { ...CORE, ...FORM }],
    ['hs_lead_status', 'Estado del lead', 'enum', 'Información de la empresa', LEAD_STATUS.slice(0, 8), CORE],
    ['type', 'Tipo', 'enum', 'Información de la empresa', [['PROSPECT', 'Prospecto'], ['PARTNER', 'Socio'], ['RESELLER', 'Revendedor'], ['VENDOR', 'Proveedor'], ['OTHER', 'Otro']], CORE],
    ['industry', 'Industria', 'enum', 'Información de la empresa', INDUSTRIAS, { ...CORE, ...FORM }],
    ['description', 'Descripción', 'text', 'Información de la empresa', [], CORE],
    ['linkedin_company_page', 'LinkedIn', 'url', 'Información de la empresa', [], CORE],
    ['city', 'Ciudad', 'string', 'Dirección', [], { ...CORE, ...FORM }],
    ['state', 'Provincia', 'string', 'Dirección', [], CORE],
    ['country', 'País', 'string', 'Dirección', [], CORE],
    ['address', 'Dirección', 'string', 'Dirección', [], CORE],
    ['zip', 'Código postal', 'string', 'Dirección', [], CORE],
    ['cuit', 'CUIT', 'string', 'Facturación'],
    ['razon_social', 'Razón social', 'string', 'Facturación'],
    ['codigo_de_finnegans', 'Código Finnegans', 'string', 'Facturación'],
    ['numberofemployees', 'Cantidad de empleados', 'number', 'Calificación', [], CORE],
    ['cantidad_de_empleados_en_argentina', 'Empleados en Argentina', 'number', 'Calificación'],
    ['annualrevenue', 'Facturación anual', 'currency', 'Calificación', [], CORE],
    ['hs_ideal_customer_profile', 'Tier ICP', 'enum', 'Calificación', [['tier_1', 'Tier 1'], ['tier_2', 'Tier 2'], ['tier_3', 'Tier 3']]],
    ['tipo_de_empresa_cotizacion', 'Tipo de empresa cotización', 'enum', 'Calificación', [['a_cotizacion_mensual', 'A · Cotización mensual'], ['b_cotizacion_trimestral', 'B · Cotización trimestral'], ['c_cotizacion_semestral', 'C · Cotización semestral']], { description: 'Frecuencia con la que se cotiza a la empresa.' }],
    ['volumen_estimado_de_pedidos_anuales_de_productos_personalizados', 'Volumen estimado de pedidos anuales', 'enum', 'Calificación', ['Bajo (1 a 3 pedidos al año)', 'Medio (4-8 pedidos al año)', 'Alto (9 a 18 pedidos al año)', 'Muy alto (19+ pedidos al año)']],
    ['objetivo_economico_anual', 'Objetivo económico anual', 'currency', 'Objetivos', [], { description: 'Meta de facturación anual esperada para esta empresa.' }],
    ['negocios_confirmados_en', 'Negocios confirmados en $', 'currency', 'Objetivos'],
    ['ultima_accion', 'Última acción', 'enum', 'Seguimiento', ['Mailing', 'Mail con Presentacion', ['Mail co n Propuesta', 'Mail con propuesta'], 'Reunion', 'Llamado', 'Whatsapp']],
    ['prospect_origin_2__company_', 'Origen del prospecto', 'string', 'Seguimiento'],
  ],
  deal: [
    ['dealname', 'Nombre del negocio', 'string', 'Información del negocio', [], { ...CORE, ...FORM, required: true }],
    ['pipeline', 'Pipeline', 'string', 'Información del negocio', [], { ...CORE, ...FORM, required: true }],
    ['dealstage', 'Etapa', 'string', 'Información del negocio', [], { ...CORE, ...FORM, required: true }],
    ['amount', 'Monto', 'currency', 'Información del negocio', [], { ...CORE, ...FORM }],
    ['deal_currency_code', 'Moneda', 'enum', 'Información del negocio', ['ARS', 'USD'], CORE],
    ['closedate', 'Fecha de cierre', 'date', 'Información del negocio', [], { ...CORE, ...FORM }],
    ['owner_id', 'Propietario', 'owner', 'Información del negocio', [], { ...CORE, ...FORM }],
    ['dealtype', 'Tipo de negocio', 'enum', 'Información del negocio', [['newbusiness', 'Cliente nuevo'], ['existingbusiness', 'Cliente existente']], CORE],
    ['hs_priority', 'Prioridad', 'enum', 'Información del negocio', [['low', 'Baja'], ['medium', 'Media'], ['high', 'Alta']], CORE],
    ['hs_next_step', 'Próximo paso', 'text', 'Información del negocio', [], CORE],
    ['description', 'Descripción', 'text', 'Información del negocio', [], CORE],
    ['descripcion_del_negocio', 'Descripción del negocio', 'string', 'Pedido'],
    ['producto', 'Producto', 'string', 'Pedido', [], FORM],
    ['cantidad', 'Cantidad', 'string', 'Pedido', [], FORM],
    ['tipo_de_producto', 'Tipo de producto', 'enum', 'Pedido', ['Productos importados', 'Desarrollos especiales', 'Producción simple', 'Importación especial', 'Mix de categorías']],
    ['tiempos_de_entrega', 'Tiempos de entrega', 'date', 'Pedido'],
    ['monto_minimo_de_compra', 'Monto mínimo de compra', 'currency', 'Pedido'],
    ['es_evento', 'Es evento', 'bool', 'Pedido', SI_NO],
    ['eventos_especiales', 'Eventos especiales', 'enum', 'Pedido', [
      'Día del Trabajador (1º de mayo) – regalos internos', 'Día del Empleado de Comercio (septiembre) – regalos al equipo',
      'Día del Maestro (11 de septiembre)', 'Día Internacional de la Mujer (8 de marzo)', 'Día del Orgullo (28 de junio)',
      'Aniversarios de empresas – personalizables todo el año', 'Lanzamientos de productos – fechas variables',
      'Convenciones y congresos – se planifican con meses de anticipación', 'Eventos deportivos corporativos – golf, fútbol, carreras, etc.',
      'Fiestas de fin de año / cierre de ejercicio', 'Onboarding de nuevos empleados – todo el año', 'Maratones y carreras sponsoreadas',
      'Ferias y exposiciones (como Expoagro, BIEL, FIT, etc.)', 'Eventos estudiantiles y egresos (noviembre-diciembre)',
      'Campañas políticas (años electorales)', 'Día del Metalúrgico – 7 de septiembre', 'Día del Petróleo / Petrolero – 13 de diciembre',
      'Día de la Minería – 7 de mayo', 'Evento interno de la Empresa', 'Stock sin destino especificado', 'Dia del Niño', 'Dia del Abogado',
    ]],
    ['tipo_de_oportunidad', 'Tipo de oportunidad', 'enum', 'Calificación', ['Nuevo requerimiento de la empresa', 'Pedido de cotización PCC', 'Nueva oportunidad generada por la EC', 'Consulta formas.ar']],
    ['estado_del_negocio', 'Estado del negocio', 'enum', 'Calificación', ['Nuevo', 'En seguimiento', 'Cliente ganado', 'Lead frío', 'Cliente perdido']],
    ['tier_de_negocio', 'Tier de negocio', 'enum', 'Calificación', ['Tier 1', 'Tier 2', 'Tier 3']],
    ['interaccion_y_confirmacion_de_interes', 'Interacción y confirmación de interés', 'bool', 'Calificación', SI_NO],
    ['cliente_asociado_al_negocio_', '¿Cliente asociado al negocio?', 'bool', 'Calificación', SI_NO],
    ['origen', 'Origen manual', 'enum', 'Origen', [
      'Evento / Exposicion', 'Llamada saliente', 'Llamada entrante', 'Contacto por Whatsapp', 'Contacto de cliente existente',
      'Ecommerce orgánico', ['Mercately', 'Darwin'], 'Ejecutivo de cuentas', 'Campaña', 'Networking', 'Cartera propia',
      'Contacto por email', 'Nueva base de datos', 'Contacto del cliente', 'Expo Rural', 'Expo Agro', 'Expo Red YPF', 'Otros',
      'Linkedin', 'Contacto de Formas', 'Facebook', 'HeyReach', 'Formulario MetaAds', 'Formulario LinkedInAds',
    ]],
    ['origen_del_negocio', 'Medio de origen', 'enum', 'Origen', CANAL],
    ['tipo_de_origen', 'Tipo de origen', 'enum', 'Origen', TIPO_ORIGEN],
    ['origen_del_prospecto', 'Origen del prospecto', 'string', 'Origen'],
    ['origen_de_la_campana', 'Origen de la campaña', 'string', 'Origen'],
    ['plataforma_de_pauta', 'Plataforma de pauta', 'enum', 'Origen', PAUTA],
    ['link_a_darwin', 'Link a Darwin', 'url', 'Origen'],
    ['cotizacion_adjuntada_al_negocio', 'Cotización adjuntada al negocio', 'bool', 'Cotización', SI_NO],
    ['confirmacion_de_recepcion_de_cotizacion', 'Confirmación de recepción de cotización', 'bool', 'Cotización', SI_NO],
    ['feedback_del_cliente', 'Feedback del cliente', 'enum', 'Cotización', ['Baja de precios', 'Selección de productos', 'Stock de productos', 'Pedido de muestras', 'Pedido de boceto', 'Fecha de entrega', 'Entregas en múltiples direcciones', 'Esperando Autorizacion de superior']],
    ['variables_de_ajustes_de_cotizacion', 'Variables de ajuste de cotización', 'enum', 'Cotización', ['Por cantidad', 'Por precio', 'Por tipo de producto']],
    ['fecha_pospuesta', 'Fecha pospuesta', 'date', 'Cotización'],
    ['tipo_de_confirmacion_del_cliente', 'Tipo de confirmación del cliente', 'enum', 'Cierre', ['Orden de compra', 'Carta de adjudicación', 'Mail de confirmación', ['Pago anticipo', 'Pago anticipo del 50%']]],
    ['pdv_en_formas_shop', 'PDV en Formas Shop', 'bool', 'Cierre', SI_NO],
    ['codigo_de_finnegans', 'Código Finnegans', 'string', 'Cierre'],
    ['motivo_de_cierre_perdido', 'Motivo de cierre perdido', 'enum', 'Cierre', [
      ['Demora en la entrega de la cotización', 'Cotización (demora)'], ['Demora en tiempo de producción', 'Tiempos de producción (demora)'],
      ['Precio', 'Precio del producto'], ['Producto', 'Producto (calidad, stock, modelo, etc.)'], ['Sin respuesta', 'No contesta'],
      ['Se dió de baja', 'No se hizo'], 'No Califica', ['Falta de Stock', 'No hay stock'], 'Calidad', 'Producto inexistente',
      'Nunca respondió', 'Pospuesto para mas adelante', 'Eligió otra propuesta',
    ]],
    ['closed_lost_reason', 'Detalle de cierre perdido', 'text', 'Cierre', [], CORE],
    ['closed_won_reason', 'Detalle de cierre ganado', 'text', 'Cierre', [], CORE],
  ],
  // Pedidos de formas.shop (hoy el objeto Order de HubSpot). `pdv_finnegans` es la llave con Finnegans y ClickUp.
  order: [
    ['hs_order_name', 'Nombre del pedido', 'string', 'Pedido', [], { ...CORE, ...FORM, required: true }],
    ['pdv_finnegans', 'PDV Finnegans', 'string', 'Pedido', [], FORM],
    ['owner_id', 'Propietario', 'owner', 'Pedido', [], { ...CORE, ...FORM }],
    ['hs_total_price', 'Total', 'currency', 'Pedido', [], CORE],
    ['hs_currency_code', 'Moneda', 'enum', 'Pedido', ['ARS', 'USD'], CORE],
    ['hs_external_order_id', 'Número de pedido web', 'string', 'Pedido', [], CORE],
    ['hs_pipeline_stage', 'Etapa del pedido', 'enum', 'Pedido', ORDER_STAGES, { ...CORE, ...FORM }],
    ['hs_pipeline', 'Pipeline del pedido', 'enum', 'Pedido', ORDER_PIPELINES, CORE],
    ['hs_order_status', 'Estado (web)', 'string', 'Pedido', [], CORE],
    ['tipo_de_pedido', 'Tipo de pedido', 'enum', 'Pedido', ['PEDIDO NORMAL', 'EVENTO'], FORM],
    ['fecha_de_entrega', 'Fecha de entrega', 'date', 'Pedido', [], FORM],
    ['url_pdv_finnegans', 'URL PDV Finnegans', 'url', 'Pedido'],
    ['saldo_pendiente_de_pago_mxn', 'Saldo pendiente de pago (ARS)', 'currency', 'Pedido'],
    ['progreso_pdv', 'Progreso PDV', 'number', 'Pedido'],
    ['items_entregados', 'Ítems entregados', 'string', 'Pedido'],
    ['unidad_de_negocio', 'Unidad de negocio', 'enum', 'Pedido', ['FORMAS SHOP', 'CORPORATE', 'NO ESTRÉS']],
    ['cliente_clickup', 'Cliente (ClickUp)', 'string', 'Pedido', [], RO],
    ['pedido_finnegans', 'Pedido en Finnegans', 'string', 'Pedido', [], RO],
    ['url_clickup', 'PDV en ClickUp', 'url', 'Pedido', [], RO],
    ['detalle_produccion', 'Detalle de producción', 'text', 'Pedido', [], RO],
    ['entregado_el', 'Entregado el', 'date', 'Pedido', [], RO],
    ['factura_numero', 'Factura', 'string', 'Pedido', [], RO],
    ['hs_billing_address_firstname', 'Nombre (facturación)', 'string', 'Facturación', [], CORE],
    ['hs_billing_address_lastname', 'Apellido (facturación)', 'string', 'Facturación', [], CORE],
    ['hs_billing_address_email', 'Email (facturación)', 'email', 'Facturación', [], CORE],
    ['hs_billing_address_phone', 'Teléfono (facturación)', 'phone', 'Facturación', [], CORE],
    ['hs_customer_phone', 'Teléfono del cliente', 'phone', 'Facturación', [], CORE],
  ],
};

// Propiedades que calcula el CRM y se muestran como solo lectura (iguales a las de HubSpot).
export const COMPUTED: Record<string, PropDef[]> = {
  contact: [
    ['createdate', 'Fecha de creación', 'datetime', 'Actividad', [], RO],
    ['notes_last_updated', 'Última actividad', 'datetime', 'Actividad', [], RO],
    ['notes_last_contacted', 'Último contacto', 'datetime', 'Actividad', [], RO],
    ['notes_next_activity_date', 'Próxima actividad', 'datetime', 'Actividad', [], RO],
    ['num_associated_deals', 'Negocios asociados', 'number', 'Actividad', [], RO],
    ['source', 'Origen del registro', 'string', 'Actividad', [], RO],
  ],
  company: [
    ['createdate', 'Fecha de creación', 'datetime', 'Actividad', [], RO],
    ['notes_last_updated', 'Última actividad', 'datetime', 'Actividad', [], RO],
    ['notes_last_contacted', 'Último contacto', 'datetime', 'Actividad', [], RO],
    ['notes_next_activity_date', 'Próxima actividad', 'datetime', 'Actividad', [], RO],
    ['num_associated_contacts', 'Contactos asociados', 'number', 'Actividad', [], RO],
    ['num_associated_deals', 'Negocios asociados', 'number', 'Actividad', [], RO],
    ['total_revenue', 'Total ganado', 'currency', 'Actividad', [], RO],
    ['estado_cliente', 'Estado del cliente', 'enum', 'Compras', ['Nuevo', 'Activo', 'Recuperado', 'En riesgo', 'Perdido', 'Dormido'], { ...RO, description: 'Se calcula solo cada noche con las compras de Finnegans (pedidos de venta, sin Mercado Libre ni MarketShell). Nuevo: primera compra en los últimos 12 meses. Recuperado: volvió a comprar después de más de 12 meses sin comprar. Activo: compró en los últimos 12 meses. En riesgo: compra seguido y lleva más de 90 días o 2,5 veces su ritmo sin comprar. Perdido: no compra hace más de 12 meses (pero sí en los 12 anteriores). Dormido: no compra hace más de 2 años.' }],
    ['fecha_ultima_compra', 'Última compra', 'date', 'Compras', [], { ...RO, description: 'Fecha del último pedido de venta en Finnegans.' }],
    ['fecha_primera_compra', 'Primera compra', 'date', 'Compras', [], { ...RO, description: 'Desde 2020 (facturas del libro de IVA) y pedidos de Finnegans desde 2023.' }],
    ['cantidad_de_compras', 'Cantidad de compras', 'number', 'Compras', [], { ...RO, description: 'Pedidos de venta (y facturas antes de 2023).' }],
    ['compra_historica_usd', 'Compra histórica (US$ MEP)', 'currency', 'Compras', [], { ...RO, description: 'Neto sin IVA, cada compra al dólar MEP de su día.' }],
    ['compra_12m_usd', 'Compra últimos 12 meses (US$ MEP)', 'currency', 'Compras', [], { ...RO, description: 'Neto sin IVA, cada compra al dólar MEP de su día.' }],
    ['ticket_promedio_usd', 'Ticket promedio (US$ MEP)', 'currency', 'Compras', [], { ...RO, description: 'Compra histórica dividida por la cantidad de compras.' }],
    ['cada_cuanto_compra', 'Compra cada (días)', 'number', 'Compras', [], { ...RO, description: 'Mediana de los días entre una compra y la siguiente.' }],
    ['saldo_pendiente', 'Saldo pendiente', 'currency', 'Compras', [], { ...RO, description: 'Lo que debe hoy en cuenta corriente, con IVA (Finnegans).' }],
    ['saldo_vencido', 'Saldo vencido', 'currency', 'Compras', [], { ...RO, description: 'La parte del saldo que ya venció, con IVA.' }],
    ['vendedora_finnegans', 'Vendedora en Finnegans', 'string', 'Compras', [], { ...RO, description: 'Quién le vendió más en los últimos 12 meses (o en su última compra).' }],
    ['unidad_finnegans', 'Unidad de negocio', 'string', 'Compras', [], { ...RO, description: 'Corporate, Formas Shop o NoEstres, según sus pedidos.' }],
    ['source', 'Origen del registro', 'string', 'Actividad', [], RO],
  ],
  deal: [
    ['createdate', 'Fecha de creación', 'datetime', 'Actividad', [], RO],
    ['notes_last_updated', 'Última actividad', 'datetime', 'Actividad', [], RO],
    ['notes_last_contacted', 'Último contacto', 'datetime', 'Actividad', [], RO],
    ['notes_next_activity_date', 'Próxima actividad', 'datetime', 'Actividad', [], RO],
    ['hs_v2_date_entered_current_stage', 'Entró a la etapa', 'datetime', 'Actividad', [], RO],
    ['source', 'Origen del registro', 'string', 'Actividad', [], RO],
  ],
  order: [
    ['createdate', 'Fecha de creación', 'datetime', 'Actividad', [], RO],
    ['source', 'Origen del registro', 'string', 'Actividad', [], RO],
  ],
};

type StageDef = [id: string, label: string, probability: number];
export const PIPELINES: Array<{ id: string; label: string; team?: number; stages: StageDef[] }> = [
  {
    id: '674405796', label: 'Corporate (Grandes Cuentas)', team: 58079782, stages: [
      ['989921330', 'Nueva Oportunidad', 0.2], ['989921332', 'Construcción de Cotización', 0.5], ['989921333', 'Respuesta de Cotización', 0.7],
      ['989921334', 'Ajuste de Cotización', 0.8], ['989921335', 'Oportunidad avanzada', 0.9], ['989921336', 'Cierre Ganado', 1], ['990121545', 'Cierre Perdido', 0],
    ],
  },
  {
    id: 'default', label: 'Formas Shop (Inbound)', team: 57132078, stages: [
      ['1000604528', 'Lead', 0.15], ['appointmentscheduled', 'Lead calificado', 0.08], ['qualifiedtobuy', 'Nueva oportunidad', 0.2],
      ['presentationscheduled', 'Envío de cotización', 0.3], ['decisionmakerboughtin', 'Respuesta de cotización', 0.65],
      ['1354091128', 'Pospuesto para más adelante', 0.05], ['contractsent', 'Ajuste de cotización / Negociación', 0.85],
      ['990934411', 'Pasos operativos', 0.92], ['closedwon', 'Cierre ganado', 1], ['closedlost', 'Cierre perdido', 0],
    ],
  },
  {
    id: '740095901', label: 'Formas Shop (Outbound)', team: 57132078, stages: [
      ['1076663589', 'Prospecto identificado', 0.1], ['1076663590', 'Primer contacto realizado', 0.2], ['1076663591', 'Respuesta del cliente', 0.3],
      ['1076663592', 'Reunión agendada', 0.4], ['1076663593', 'Reunión realizada', 0.5], ['1076798866', 'Envío de cotización', 0.6],
      ['1086849681', 'Respuesta de cotización', 0.7], ['1076798867', 'Ajuste de cotización', 0.8], ['1086856840', 'Pasos operativos', 0.9],
      ['1076663594', 'Cierre ganado', 1], ['1076663595', 'Cierre perdido', 0],
    ],
  },
  {
    id: '687889576', label: 'Noestres (Inbound)', team: 57393663, stages: [
      ['1007268974', 'Nueva oportunidad', 0.1], ['1007268975', 'Envío de cotización', 0.3], ['1007268976', 'Respuesta de cotización', 0.5],
      ['1087443027', 'Ajuste de cotización', 0.7], ['1087443028', 'Pasos operativos', 0.9], ['1007268979', 'Cierre ganado', 1], ['1007268980', 'Cierre perdido', 0],
    ],
  },
  {
    id: '746355608', label: 'Noestres (Outbound)', team: 57393663, stages: [
      ['1087559776', 'Prospecto identificado', 0.1], ['1087559777', 'Primer contacto realizado', 0.2], ['1087559778', 'Respuesta del cliente', 0.3],
      ['1087559780', 'Envío de cotización', 0.5], ['1087337887', 'Respuesta de cotización', 0.6], ['1087337888', 'Ajuste de cotización', 0.7],
      ['1087337889', 'Pasos operativos', 0.9], ['1087559781', 'Cierre ganado', 1], ['1087559782', 'Cierre perdido', 0],
    ],
  },
  {
    id: '765787061', label: 'Networking & Expos', stages: [
      ['1117101348', 'Prospecto', 0.1], ['1117101349', 'Primer contacto realizado', 0.2], ['1117101350', 'Respuesta del cliente', 0.3],
      ['1117101351', 'Reunión agendada', 0.4], ['1117101352', 'Reunión realizada', 0.6], ['1117101353', 'Lead calificado', 1], ['1117101354', 'Lead perdido', 0],
    ],
  },
  {
    id: '772119841', label: 'Híbrido (Outbound)', stages: [
      ['1127106444', 'Prospecto identificado', 0.1], ['1127116631', 'Primer contacto realizado', 0.2], ['1127116632', 'Respuesta del cliente', 0.3],
      ['1127116633', 'Reunión agendada', 0.4], ['1127116634', 'Reunión realizada', 0.5], ['1127116635', 'Envío de cotización', 0.6],
      ['1127106445', 'Respuesta de cotización', 0.7], ['1127106446', 'Ajuste de cotización', 0.8], ['1127106447', 'Pasos operativos', 0.9],
      ['1127116636', 'Cierre ganado', 1], ['1127116637', 'Cierre perdido', 0],
    ],
  },
  {
    id: '833718584', label: 'Formas Shop · Operaciones', team: 57132078, stages: [
      ['1237285916', 'Pedido confirmado', 0.1], ['1237424564', '$ Pendiente de anticipo', 0.2], ['1237285917', 'Boceto digital', 0.2],
      ['1237285918', 'Listo para producción', 0.3], ['1237285919', 'En producción', 0.5], ['1237285920', '$ Pendiente de saldo', 0.8],
      ['1237285921', 'Listo para despachar', 0.9], ['1237285942', 'Listo para retirar', 0.9], ['1237285943', 'Pedido completo', 1], ['1237285922', 'Pedido cancelado', 0],
    ],
  },
];

// Una etapa es "cerrada" si su probabilidad es 0 o 1 y el nombre lo dice; "ganada" si es 1.
function stageFlags(label: string, probability: number) {
  const l = label.toLowerCase();
  const closed = /cierre|perdido|completo|cancelado|lead calificado/.test(l) && (probability === 0 || probability === 1);
  return { is_closed: closed ? 1 : 0, is_won: closed && probability === 1 ? 1 : 0 };
}

export async function seedConfig(db: D1Database) {
  const stmts: D1PreparedStatement[] = [];
  for (const [id, name] of TEAMS) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO teams (id, name, hs_id) VALUES (?, ?, ?)').bind(id, name, String(id)));
  }
  const insertProp = db.prepare(`INSERT OR IGNORE INTO properties
    (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const source of [PROPERTIES, COMPUTED]) {
    for (const [objectType, defs] of Object.entries(source)) {
      defs.forEach(([name, label, type, group = 'Información', options = [], extra = {}], i) => {
        const opts = options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : { value: o, label: o }));
        const f = extra as Partial<PropFlags>;
        stmts.push(insertProp.bind(objectType, name, label, type, JSON.stringify(opts), group, f.description ?? '',
          (source === COMPUTED ? 1000 : 0) + i, f.system ? 1 : 0, f.read_only ? 1 : 0, f.in_create_form ? 1 : 0, f.required ? 1 : 0));
      });
    }
  }
  PIPELINES.forEach((p, i) => {
    const sales = !['765787061', '833718584'].includes(p.id);
    // Corporate pide empresa; Formas Shop (Inbound) arranca con la tarjeta y el «Acerca de» que tiene en HubSpot.
    const config = p.id === '674405796' ? { rules: { require_company: true } }
      : p.id === 'default' ? { card_props: ['amount', 'createdate', 'fecha_pospuesta'], key_props: ['link_a_darwin', 'producto', 'cantidad', 'eventos_especiales', 'notes_last_contacted', 'origen', 'owner_id'] } : {};
    stmts.push(db.prepare('INSERT OR IGNORE INTO pipelines (id, object_type, label, display_order, team_id, config) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(p.id, 'deal', p.label, i, p.team ?? null, JSON.stringify(config)));
    p.stages.forEach(([id, label, probability], j) => {
      const f = stageFlags(label, probability);
      // Perder un negocio de venta pide el motivo.
      const stageConfig = sales && f.is_closed && !f.is_won ? { required_props: ['motivo_de_cierre_perdido'] } : {};
      stmts.push(db.prepare('INSERT OR IGNORE INTO stages (id, pipeline_id, label, display_order, probability, is_closed, is_won, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, p.id, label, j, probability, f.is_closed, f.is_won, JSON.stringify(stageConfig)));
    });
  });
  stmts.push(db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('seeded', ?)").bind(new Date().toISOString()));
  await db.batch(stmts);
}
