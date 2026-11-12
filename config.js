// Configuração do VERA ETO — Plano de Manutenção.
// A chave abaixo é a chave PÚBLICA (publishable) do Supabase: foi feita para ficar no navegador.
// Quem protege os dados são as regras do banco (supabase/schema.sql): o app só acrescenta inspeções e fotos;
// não altera nem apaga nada. Distribuir quadra exige o PIN do gestor.
window.PM_CONFIG = {
  versao: '1.0.0',
  supabaseUrl: 'https://uabpevnjfcwidbjscowq.supabase.co',
  supabaseChave: 'sb_publishable_SHH7EV0MT5grOTdCFM-V-w_FqPrtzPh',
  bucketFotos: 'pm-fotos',
  equipe: 'Palmas',
  prazoFinal: '2027-12-31',
  // Foto obrigatória em cada item com anomalia? (a decidir com o Matheus)
  fotoObrigatoria: false,
  // Distância (m) do GPS até o poste acima da qual o app pede confirmação.
  distanciaAviso: 60
};
