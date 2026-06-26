import { Hero } from "@/components/sections/Hero";
import { Proof } from "@/components/sections/Proof";
import { Problem } from "@/components/sections/Problem";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { Platform } from "@/components/sections/Platform";
import { Solutions } from "@/components/sections/Solutions";

export default function HomePage() {
  return (
    <main>
      <Hero />
      <Proof />
      <Problem />
      <HowItWorks />
      <Platform />
      <Solutions />
    </main>
  );
}
