import { useEffect, useState } from "react";
export function Counter({ start }: { start: number }) {
  const [count, setCount] = useState(start);
  useEffect(() => {
    setCount(start);
  }, [start]);
  return <span>{count}</span>;
}
