import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  FailoverRpcProvider,
  getTransactionLastResult,
  JsonRpcProvider,
} from 'near-api-js';
import { NearConnector, type EventMap, type NearConnectorOptions } from '@hot-labs/near-connect';

import { NetworkId } from '@/config';

type ViewFunctionParams = {
  contractId: string;
  method: string;
  args?: Record<string, unknown>;
};

type CallFunctionParams = ViewFunctionParams & {
  gas?: string;
  deposit?: string;
};

type NearContextValue = {
  loading: boolean;
  signedAccountId: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  viewFunction: (params: ViewFunctionParams) => Promise<unknown>;
  callFunction: (params: CallFunctionParams) => Promise<unknown>;
};

const NearContext = createContext<NearContextValue | undefined>(undefined);

const connectorOptions: NearConnectorOptions = {
  network: NetworkId,
  providers: {
    mainnet: ['https://free.rpc.fastnear.com'],
    testnet: ['https://test.rpc.fastnear.com'],
  },
};

export function NearProvider({ children }: PropsWithChildren) {
  const connector = useMemo(() => new NearConnector(connectorOptions), []);
  const provider = useMemo(
    () => {
      const rpcUrls: string[] =
        NetworkId === 'mainnet' ? connector.providers.mainnet ?? [] : connector.providers.testnet ?? [];
      return new FailoverRpcProvider(rpcUrls.map((url) => new JsonRpcProvider({ url })));
    },
    [connector],
  );

  const [wallet, setWallet] = useState<Awaited<ReturnType<NearConnector['wallet']>> | undefined>();
  const [signedAccountId, setSignedAccountId] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      const connectedWallet = await connector.getConnectedWallet().catch(() => null);
      if (!cancelled && connectedWallet) {
        setWallet(connectedWallet.wallet);
        setSignedAccountId(connectedWallet.accounts[0]?.accountId ?? '');
      }
      if (cancelled) return undefined;

      const handleSignIn = (payload: EventMap['wallet:signIn']) => {
        if (!cancelled) {
          setWallet(payload.wallet);
          setSignedAccountId(payload.accounts[0]?.accountId ?? '');
        }
      };
      const handleSignOut = () => {
        if (!cancelled) {
          setWallet(undefined);
          setSignedAccountId('');
        }
      };

      connector.on('wallet:signIn', handleSignIn);
      connector.on('wallet:signOut', handleSignOut);

      if (!cancelled) {
        setLoading(false);
      }

      return () => {
        connector.off('wallet:signIn', handleSignIn);
        connector.off('wallet:signOut', handleSignOut);
      };
    };

    let cleanup: (() => void) | undefined;
    void initialize().then((removeListeners) => {
      if (cancelled) removeListeners?.();
      else cleanup = removeListeners;
    }).catch((error) => {
      console.error('Unable to initialize wallet', error);
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [connector]);

  const signIn = useCallback(async () => {
    const connectedWallet = await connector.connect();
    setWallet(connectedWallet);
    const accounts = await connectedWallet.getAccounts();
    setSignedAccountId(accounts[0]?.accountId ?? '');
  }, [connector]);

  const signOut = useCallback(async () => {
    if (!wallet) return;
    await connector.disconnect(wallet);
    setWallet(undefined);
    setSignedAccountId('');
  }, [connector, wallet]);

  const viewFunction = useCallback(
    ({ contractId, method, args = {} }: ViewFunctionParams) =>
      provider.callFunction({ contractId, method, args }),
    [provider],
  );

  const callFunction = useCallback(
    async ({ contractId, method, args = {}, gas = '30000000000000', deposit = '0' }: CallFunctionParams) => {
      if (!wallet) throw new Error('Wallet is not connected');

      const result = await wallet.signAndSendTransaction({
        receiverId: contractId,
        actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas, deposit } }],
      });
      return getTransactionLastResult(result);
    },
    [wallet],
  );

  const value = useMemo(
    () => ({ loading, signedAccountId, signIn, signOut, viewFunction, callFunction }),
    [callFunction, loading, signIn, signOut, signedAccountId, viewFunction],
  );

  return <NearContext.Provider value={value}>{children}</NearContext.Provider>;
}

export function useNearWallet() {
  const context = useContext(NearContext);
  if (!context) throw new Error('useNearWallet must be used within NearProvider');
  return context;
}
