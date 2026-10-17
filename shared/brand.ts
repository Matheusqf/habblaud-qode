// Nome do produto em vigor: padrão do app (QODE Office); o pacote de tema em vigor no cliente
// (shared/theme-packs) troca no boot da página (setProductName). Enquanto ninguém troca, o
// pacote QODE do log do servidor, avisos e estória do projeto ficam no nome atual.
export let PRODUCT_NAME = 'QODE Office';

/** Troca o nome do produto na página (uso no boot, pelo pacote de tema). */
export function setProductName(name: string): void {
  PRODUCT_NAME = name;
}
