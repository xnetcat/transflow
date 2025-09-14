import React, { createContext, useContext } from "react";

export interface TransflowEndpoints {
  action: string; // create-upload endpoint
  status: string; // status polling endpoint
}

const DefaultEndpoints: TransflowEndpoints = {
  action: "/api/transflow/create-upload",
  status: "/api/transflow/status",
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
    status: endpoints?.status || DefaultEndpoints.status,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTransflowEndpoints() {
  return useContext(Ctx);
}
