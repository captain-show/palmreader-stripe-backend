// Minimal Express server with Stripe subscription endpoints and static frontend serving
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 4242;

app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:8080', 'http://localhost:5000', 'https://webpall.com'],
    credentials: true
}));
app.use(bodyParser.json());

// Nocache middleware to prevent caching of API responses
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Expires', '0');
    res.set('Pragma', 'no-cache');
    next();
});

// Validate env
const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
const secretKey = process.env.STRIPE_SECRET_KEY_TEST || '';

if (!secretKey) {
    console.warn('STRIPE_SECRET_KEY is not set. Set it in backend/.env');
}

const stripe = require('stripe')(secretKey, {
    apiVersion: '2024-06-20',
});

// API: public config
app.get('/api/config', (req, res) => {
    res.json({ 
        publishableKey,
        applePayEnabled: !!publishableKey && !!secretKey
    });
});

// Helper to fetch product info safely
async function getProductDetails(productId) {
    if (!productId) return null;
    try {
        const product = await stripe.products.retrieve(productId);
        const prices = await stripe.prices.list({
            product: productId,
            active: true,
            limit: 1
        });
        const price = prices.data[0];
        
        return {
            id: product.id,
            name: product.name,
            description: product.description,
            currency: price?.currency || 'usd',
            unitAmount: price?.unit_amount || 0,
            recurring: price?.recurring || null,
            priceId: price?.id || null,
        };
    } catch (err) {
        return null;
    }
}

// API: products for plans
app.get('/api/products', async (req, res) => {
    try {
        const { weekly, monthly, yearly } = req.query;
        
        if (!weekly || !monthly || !yearly) {
            return res.status(400).json({ error: { message: 'Missing product IDs' } });
        }
        
        const [w, m, y] = await Promise.all([
            getProductDetails(weekly),
            getProductDetails(monthly),
            getProductDetails(yearly),
        ]);
        res.json({
            plans: {
                weekly: w,
                monthly: m,
                yearly: y,
            }
        });
    } catch (err) {
        res.status(500).json({ error: { message: 'Failed to load products' } });
    }
});

// API: create subscription
// Expects { email, priceId, paymentMethodId }
app.post('/api/create-subscription', async (req, res) => {
    const { email, priceId, paymentMethodId } = req.body || {};
    if (!priceId || !paymentMethodId || !email) {
        return res.status(400).json({ error: { message: 'Missing email, priceId or paymentMethodId' } });
    }

    try {
        const customer = await stripe.customers.create({
            email: email,
        });

        await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
        await stripe.customers.update(customer.id, {
            invoice_settings: { default_payment_method: paymentMethodId }
        });

        const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: priceId }],
            payment_behavior: 'default_incomplete',
            expand: ['latest_invoice.payment_intent'],
        });

        const latestInvoice = subscription.latest_invoice;
        const paymentIntent = latestInvoice && latestInvoice.payment_intent;
        const clientSecret = paymentIntent && paymentIntent.client_secret;

        res.json({
            subscriptionId: subscription.id,
            clientSecret,
            status: paymentIntent?.status || subscription.status,
        });
    } catch (err) {
        res.status(400).json({ error: { message: err.message } });
    }
});

// API only - no static files
app.get('*', (req, res) => {
    res.status(404).json({ error: { message: 'API endpoint not found' } });
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});


