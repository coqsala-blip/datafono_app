require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('Falta STRIPE_SECRET_KEY en las variables de entorno.');
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Endpoint 1: Crear el cobro real en Stripe
app.post('/crear-cobro', async (req, res) => {
  try {
    const { monto } = req.body;
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(monto * 100), // Stripe calcula en céntimos
      currency: 'eur',
      payment_method_types: ['card'],
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint 2: Token de conexión para NFC (Tap to Pay)
app.post('/token-nfc', async (req, res) => {
  try {
    const token = await stripe.terminal.connectionTokens.create();
    res.json({ secret: token.secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, '0.0.0.0', () => {
  console.log('🚀 Servidor de cobros listo y escuchando en el puerto 3000');
});