import React from 'react';
import { NicheType, NicheConfig } from '../types';
import { NICHES } from '../constants';
import { CheckCircle2 } from 'lucide-react';

interface NicheSelectorProps {
  selectedNiche: NicheType;
  onSelect: (niche: NicheType) => void;
}

export const NicheSelector: React.FC<NicheSelectorProps> = ({ selectedNiche, onSelect }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {Object.values(NICHES).map((niche) => {
        const isSelected = selectedNiche === niche.id;
        return (
          <button
            key={niche.id}
            onClick={() => onSelect(niche.id)}
            className={`relative p-4 rounded-xl border text-left transition-all duration-200 hover:scale-[1.02] ${
              isSelected
                ? 'bg-indigo-900/20 border-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.2)]'
                : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'
            }`}
          >
            <div className="flex items-start justify-between mb-2">
              <span className="text-2xl">{niche.icon}</span>
              {isSelected && <CheckCircle2 className="w-5 h-5 text-indigo-400" />}
            </div>
            <h3 className={`font-semibold ${isSelected ? 'text-indigo-300' : 'text-slate-200'}`}>
              {niche.name}
            </h3>
            <p className="text-xs text-slate-400 mt-1 line-clamp-2">
              {niche.description}
            </p>
          </button>
        );
      })}
    </div>
  );
};
