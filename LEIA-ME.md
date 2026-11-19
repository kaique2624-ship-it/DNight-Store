# DNight Store na Vercel

- Site e funções: **Vercel** · Dados (produtos, pedidos, fotos): **Firestore** · Arquivos dos jogos: **Vercel Blob**
- Pix: **Mercado Pago** · Contas dos clientes: **Firebase Authentication**

## 1. Firebase (uma vez)
1. console.firebase.google.com → projeto **dnightstore** → **Firestore Database → Criar banco de dados**
   (modo de produção, local `southamerica-east1 (São Paulo)`).
2. **Authentication → Método de login → E-mail/senha → Ativar**.

## 2. GitHub
Envie **todos os arquivos desta pasta** para o repositório. Nenhum deles tem senha ou token.
Nunca envie o arquivo de variáveis nem o `.json` da conta de serviço do Firebase.

## 3. Vercel
1. Importe o repositório (Pré-ajuste: **Other**, Diretório raiz: `./`).
2. Em **Variáveis de ambiente**, cadastre as variáveis do arquivo `VARIAVEIS-VERCEL...txt`.
3. **Implantar**.
4. No projeto: **Storage → Create → Blob** → acesso **Public** → marque
   **"Add a read-write token env var to this connection"** → Create.
5. **Deployments → ⋯ → Redeploy** (para a função enxergar o token do Blob).

## 4. Usar
- Loja: `https://SEU-PROJETO.vercel.app` · Admin: `/admin.html` (senha = `ADMIN_PASSWORD`).
- Cadastre os produtos e envie os arquivos dos jogos pelo admin (vão direto para o Vercel Blob).
- O aviso de pagamento do Mercado Pago (webhook) é configurado sozinho em cada Pix.

## Rodar no computador (opcional)
Copie `.env.exemplo` para `.env`, preencha e rode `npm install` e depois `node server.js`.
