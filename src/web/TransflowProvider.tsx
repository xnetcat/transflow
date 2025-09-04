import React, { createContext, useContext } from "react";

export interface TransflowEndpoints {
  action: string; // create-upload endpoint
  stream: string; // stream endpoint
}

const DefaultEndpoints: TransflowEndpoints = {
  action: "/api/transflow/create-upload",
  stream: "/api/transflow/stream",
};

const Ctx = createContext<TransflowEndpoints>(DefaultEndpoints);

export function TransflowProvider({
  endpoints,
  children,
}: {
  endpoints?: Partial<TransflowEndpoints>;
  children: React.ReactNode;
}) {
  const value: TransflowEndpoints = {
    action: endpoints?.action || DefaultEndpoints.action,
    stream: endpoints?.stream || DefaultEndpoints.stream,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTransflowEndpoints() {
  return useContext(Ctx);
}
