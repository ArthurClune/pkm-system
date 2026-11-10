// Fixture: react-hooks/exhaustive-deps must flag the missing `start` dep.
import { useEffect, useState } from "react";

export function Counter({ start }: { start: number }) {
  const [count, setCount] = useState(start);
  useEffect(() => {
    setCount(start);
  }, []);
  return <span>{count}</span>;
}
