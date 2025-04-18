import React, { useState, useCallback, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import {
  Box,
  Container,
  Typography,
  Paper,
  Button,
  TextField,
  Grid,
  Avatar,
  Divider,
  CircularProgress,
  Alert,
  Snackbar,
} from '@mui/material';
import { ethers } from 'ethers';
import useContracts from '../hooks/useContracts';
import useWallet from '../hooks/useWallet';
import { config } from '../config';

interface TokenData {
  address: string;
  symbol: string;
  name: string;
  price: string;
  priceUSD: string;
  marketCap: string;
  bondingProgress: number;
}

const BONDING_CURVE_THRESHOLD = ethers.utils.parseUnits('85000', 8); // 85k USD with 8 decimals

const Trade = () => {
  const { address } = useParams<{ address: string }>();
  const { buyToken, sellToken, getTokenPrice } = useContracts();
  const { isConnected, chainId } = useWallet();
  const [amount, setAmount] = useState('');
  const [transactionLoading, setTransactionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenInfo, setTokenInfo] = useState<TokenData | null>(null);

  const calculateBondingProgress = (marketCapUSD: ethers.BigNumber): number => {
    if (marketCapUSD.isZero()) return 0;
    if (marketCapUSD.gte(BONDING_CURVE_THRESHOLD)) return 100;
    return Math.floor(marketCapUSD.mul(100).div(BONDING_CURVE_THRESHOLD).toNumber());
  };

  const fetchTokenInfo = useCallback(async () => {
    console.log('TRADE: fetchTokenInfo called', { address, chainId, isConnected });
    try {
      if (!chainId || !address) {
        console.log('TRADE: fetchTokenInfo - missing chainId or address');
        return;
      }

      setLoading(true);
      const chainConfig = config[chainId.toString() as keyof typeof config];
      if (!chainConfig) {
        throw new Error('Chain config not found');
      }

      const provider = new ethers.providers.Web3Provider(window.ethereum);
      const contract = new ethers.Contract(
        address,
        [
          'function symbol() view returns (string)',
          'function name() view returns (string)',
          'function totalSupply() view returns (uint256)'
        ],
        provider
      );

      const pumpFunEVMContract = new ethers.Contract(
        chainConfig.pumpFunEVM.address,
        ['function getMarketCapInUSD(address) view returns (uint256)'],
        provider
      );
      
      console.log('TRADE: Fetching token data from contracts...');
      const [symbol, name, priceInWCTC, marketCapInUSD] = await Promise.all([
        contract.symbol(),
        contract.name(),
        getTokenPrice(address),
        pumpFunEVMContract.getMarketCapInUSD(address)
      ]);

      // Convert price from WCTC to USD (1 WCTC = $2000)
      const WCTC_PRICE_USD = 2000;
      const priceInUSD = parseFloat(priceInWCTC) * WCTC_PRICE_USD;

      console.log('TRADE: Raw market cap:', marketCapInUSD.toString());
      
      // Market cap comes in with 8 decimals from the contract
      const marketCapUSDFormatted = parseFloat(ethers.utils.formatUnits(marketCapInUSD, 8));

      console.log('TRADE: Calculated token info:', {
        symbol,
        priceInWCTC,
        priceInUSD,
        marketCapInUSD: marketCapInUSD.toString(),
        marketCapUSDFormatted
      });

      // For testing, hardcode the values
      const newTokenInfo = {
        address,
        symbol,
        name,
        price: "0.00000001", // Hardcoded for testing
        priceUSD: "0.00000020", // Hardcoded for testing
        marketCap: "222,222,222,220,000.00", // Hardcoded for testing
        bondingProgress: calculateBondingProgress(marketCapInUSD)
      };

      console.log('TRADE: Setting local token info:', newTokenInfo);
      setTokenInfo(newTokenInfo);
    } catch (error) {
      console.error('TRADE: Error fetching token info:', error);
      setError('Failed to fetch token information');
    } finally {
      setLoading(false);
    }
  }, [address, chainId, getTokenPrice]);

  useEffect(() => {
    console.log('TRADE: useEffect for fetching triggered', { isConnected, address });
    if (isConnected && address) {
      console.log('TRADE: Starting initial fetch and interval');
      fetchTokenInfo();
      const interval = setInterval(() => {
        console.log('TRADE: Interval fetch triggered');
        fetchTokenInfo();
      }, 5000);
      return () => {
        console.log('TRADE: Cleaning up interval');
        clearInterval(interval);
      };
    }
  }, [isConnected, address, fetchTokenInfo]);

  const handleBuy = async () => {
    if (!isConnected) {
      setError('Please connect your wallet first');
      return;
    }

    if (!address) {
      setError('Token address is required');
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    setTransactionLoading(true);
    setError(null);
    setTxHash(null);

    try {
      const result = await buyToken(address, amount);
      if (result.success) {
        setTxHash(result.txHash);
        setAmount('');
        console.log('TRADE: Buy successful, fetching updated token info');
        await fetchTokenInfo();
      } else {
        setError('Transaction failed');
      }
    } catch (error: any) {
      console.error('Buy error:', error);
      setError(error.message || 'Failed to buy tokens');
    } finally {
      setTransactionLoading(false);
    }
  };

  const handleSell = async () => {
    if (!isConnected) {
      setError('Please connect your wallet first');
      return;
    }

    if (!address) {
      setError('Token address is required');
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    setTransactionLoading(true);
    setError(null);
    setTxHash(null);

    try {
      const result = await sellToken(address, amount);
      if (result.success) {
        setTxHash(result.txHash);
        setAmount('');
        console.log('TRADE: Sell successful, fetching updated token info');
        await fetchTokenInfo();
      } else {
        setError('Transaction failed');
      }
    } catch (error: any) {
      console.error('Sell error:', error);
      setError(error.message || 'Failed to sell tokens');
    } finally {
      setTransactionLoading(false);
    }
  };

  if (loading || !tokenInfo) {
    console.log('TRADE: Rendering loading state', { loading, tokenInfo });
    return (
      <Container>
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="80vh">
          <CircularProgress />
        </Box>
      </Container>
    );
  }

  console.log('TRADE: Rendering with tokenInfo:', tokenInfo);
  return (
    <Container maxWidth="lg">
      <Box py={4}>
        <Paper elevation={3}>
          <Box p={3}>
            <Grid container spacing={4}>
              {/* Token Info Section */}
              <Grid item xs={12} md={4}>
                <Box display="flex" alignItems="center" mb={2}>
                  <Avatar sx={{ width: 56, height: 56, mr: 2 }}>
                    {tokenInfo.symbol[0]}
                  </Avatar>
                  <Box>
                    <Typography variant="h5">{tokenInfo.symbol}</Typography>
                    <Typography variant="body2" color="textSecondary">
                      {tokenInfo.name}
                    </Typography>
                  </Box>
                </Box>
                <Typography variant="h6" gutterBottom>
                  Price: {tokenInfo.price} WCTC (${tokenInfo.priceUSD})
                </Typography>
                <Typography variant="body1" gutterBottom>
                  Market Cap: {tokenInfo.marketCap === "0.00" ? (
                    <>
                      <Typography color="warning.main" component="span">
                        Zero Price Mode
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                        • Initial fixed price: 1 token = 0.0000001 WCTC
                        <br />
                        • Need 5 WCTC liquidity to exit zero price mode
                        <br />
                        • Market cap will be displayed after exiting zero price mode
                      </Typography>
                    </>
                  ) : (
                    `$${tokenInfo.marketCap}`
                  )}
                </Typography>
                <Box mt={2}>
                  <Typography variant="body2" gutterBottom>
                    Bonding Curve Progress
                  </Typography>
                  <Box position="relative" height={8} bgcolor="grey.200" borderRadius={5}>
                    <Box
                      position="absolute"
                      height="100%"
                      bgcolor="primary.main"
                      borderRadius={5}
                      style={{ width: `${tokenInfo.bondingProgress}%` }}
                    />
                  </Box>
                  <Typography variant="body2" color="textSecondary" align="right">
                    {tokenInfo.bondingProgress}%
                  </Typography>
                </Box>
              </Grid>

              {/* Chart Section */}
              <Grid item xs={12} md={8}>
                <Paper elevation={1} sx={{ height: 400, p: 2, bgcolor: 'grey.100' }}>
                  <Typography variant="body2" color="textSecondary" align="center">
                    Chart coming soon
                  </Typography>
                </Paper>
              </Grid>

              {/* Trading Section */}
              <Grid item xs={12}>
                <Divider sx={{ my: 2 }} />
                <Box display="flex" alignItems="center" gap={2}>
                  <TextField
                    fullWidth
                    label="Amount"
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    disabled={transactionLoading}
                  />
                  <Button
                    variant="contained"
                    color="primary"
                    onClick={handleBuy}
                    disabled={transactionLoading}
                  >
                    {transactionLoading ? <CircularProgress size={24} /> : 'Buy'}
                  </Button>
                  <Button
                    variant="outlined"
                    color="primary"
                    onClick={handleSell}
                    disabled={transactionLoading}
                  >
                    {transactionLoading ? <CircularProgress size={24} /> : 'Sell'}
                  </Button>
                </Box>
              </Grid>
            </Grid>
          </Box>
        </Paper>
      </Box>

      <Snackbar
        open={!!error}
        autoHideDuration={6000}
        onClose={() => setError(null)}
      >
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>

      <Snackbar
        open={!!txHash}
        autoHideDuration={6000}
        onClose={() => setTxHash(null)}
      >
        <Alert severity="success" onClose={() => setTxHash(null)}>
          Transaction submitted! View on{' '}
          <a
            href={`https://blockscout.com/ctc/mainnet/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'inherit' }}
          >
            BlockScout
          </a>
        </Alert>
      </Snackbar>
    </Container>
  );
};

export default Trade; 